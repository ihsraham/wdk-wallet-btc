// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { address as btcAddress, crypto, networks, payments, script, Transaction } from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'

const MAX_MONEY = 2_100_000_000_000_000n

/** Validate fixture values before converting them to the client's numeric API. */
function satoshis (value) {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new Error('A satoshi value must be a bigint or a safe integer')
  }
  const amount = BigInt(value)
  if (amount < 0n || amount > MAX_MONEY) throw new Error('Satoshi value out of range')
  return amount
}

/**
 * An offline IBtcClient fixture with real P2WPKH and P2PKH signature verification.
 *
 * Funding is synthetic historical data, not consensus-valid mined funding.
 * This fixture supports SIGHASH_ALL P2WPKH and compressed-key P2PKH spends. It does not implement
 * consensus, script execution for other inputs, coinbase maturity, RBF,
 * reorgs, timelocks, or mempool relay policies.
 */
export class InMemoryBitcoinClient {
  constructor ({ network = networks.regtest, feeRate = 2 } = {}) {
    if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error('Invalid fixture fee rate')
    this.network = network
    this.feeRate = feeRate
    this.calls = []
    this.broadcasts = []
    /** @private */
    this._connected = false
    /** @private */
    this._height = 100
    /** @private */
    this._fundingSequence = 0
    /** @private */
    this._transactions = new Map()
    /** @private */
    this._outputs = new Map()
    /** @private */
    this._unspent = new Set()
  }

  get isConnected () { return this._connected }

  async connect () {
    this.calls.push({ method: 'connect' })
    this._connected = true
  }

  async close () {
    this.calls.push({ method: 'close' })
    this._connected = false
  }

  async reconnect () {
    this.calls.push({ method: 'reconnect' })
    this._connected = true
  }

  /** Create a unique historical funding transaction and return its txid. */
  fund (address, value, { confirmed = true } = {}) {
    const amount = satoshis(value)
    if (amount === 0n) throw new Error('Funding must be positive')
    const outputScript = btcAddress.toOutputScript(address, this.network)
    const tx = new Transaction()
    const marker = new Uint8Array(8)
    new DataView(marker.buffer).setUint32(0, ++this._fundingSequence, true)
    // The null previous hash also lets wallet history recognize synthetic
    // funding without trying to retrieve a nonexistent parent transaction.
    tx.addInput(new Uint8Array(32), 0xffffffff, undefined, marker)
    tx.addOutput(outputScript, amount)
    this._recordTransaction(tx, confirmed ? this._height : 0, [])
    return tx.getId()
  }

  /** Confirm every pending transaction in the next synthetic block. */
  mine () {
    this._height += 1
    for (const record of this._transactions.values()) {
      if (record.height === 0) record.height = this._height
    }
    for (const output of this._outputs.values()) {
      if (output.height === 0) output.height = this._height
    }
    return this._height
  }

  async getBlockHeight () {
    this.calls.push({ method: 'getBlockHeight' })
    return this._height
  }

  async estimateFee (blocks) {
    this.calls.push({ method: 'estimateFee', blocks })
    // IBtcClient uses BTC/kB; wallet fee planning multiplies this by 100,000.
    return this.feeRate / 100_000
  }

  async getBalance (address) {
    this.calls.push({ method: 'getBalance', address })
    let confirmed = 0n
    let unconfirmed = 0n
    for (const [outpoint, output] of this._outputs) {
      if (output.address !== address) continue
      const spender = output.spentBy && this._transactions.get(output.spentBy)
      if (output.height > 0) {
        if (!spender || spender.height === 0) confirmed += output.value
        if (spender?.height === 0) unconfirmed -= output.value
      } else if (this._unspent.has(outpoint)) {
        unconfirmed += output.value
      }
    }
    return { confirmed: Number(confirmed), unconfirmed: Number(unconfirmed) }
  }

  async listUnspent (address) {
    this.calls.push({ method: 'listUnspent', address })
    const result = []
    for (const outpoint of this._unspent) {
      const output = this._outputs.get(outpoint)
      if (output.address === address) {
        result.push({ tx_hash: output.txid, tx_pos: output.vout, value: Number(output.value), height: output.height })
      }
    }
    return result
  }

  async getHistory (address) {
    this.calls.push({ method: 'getHistory', address })
    return [...this._transactions]
      .filter(([, record]) => record.addresses.has(address))
      .map(([txid, record]) => ({ tx_hash: txid, height: record.height }))
  }

  async getTransaction (txid) {
    this.calls.push({ method: 'getTransaction', txid })
    const record = this._transactions.get(txid)
    if (!record) throw new Error(`Unknown transaction: ${txid}`)
    return record.hex
  }

  /**
   * Decode a spend and verify all references, values and supported signatures.
   * Historical outputs remain available, so accepted spends can be inspected.
   * Only broadcast additionally requires every input to be currently unspent.
   */
  inspectTransaction (hex) {
    const tx = Transaction.fromHex(hex)
    if (tx.ins.length === 0 || tx.outs.length === 0) throw new Error('Transaction needs inputs and outputs')
    const seen = new Set()
    const inputs = tx.ins.map((input, index) => {
      const txid = Buffer.from(input.hash).reverse().toString('hex')
      const outpoint = `${txid}:${input.index}`
      if (seen.has(outpoint)) throw new Error('Duplicate transaction input')
      seen.add(outpoint)
      const previous = this._outputs.get(outpoint)
      if (!previous) throw new Error(`Unknown input: ${outpoint}`)
      const segwit = previous.script.length === 22 && previous.script[0] === 0 && previous.script[1] === 20
      const legacy = previous.script.length === 25 && previous.script[0] === 0x76 &&
        previous.script[1] === 0xa9 && previous.script[2] === 0x14 &&
        previous.script[23] === 0x88 && previous.script[24] === 0xac
      let encodedSignature, publicKey, ownerHash
      if (segwit) {
        if (input.script.length !== 0 || input.witness.length !== 2) throw new Error('Invalid P2WPKH witness')
        ;[encodedSignature, publicKey] = input.witness
        ownerHash = previous.script.subarray(2)
      } else if (legacy) {
        const chunks = script.decompile(input.script)
        if (input.witness.length !== 0 || !chunks || chunks.length !== 2 ||
            !chunks.every(chunk => chunk instanceof Uint8Array)) throw new Error('Invalid P2PKH scriptSig')
        ;[encodedSignature, publicKey] = chunks
        ownerHash = previous.script.subarray(3, 23)
      } else {
        throw new Error('Fixture only verifies P2WPKH and P2PKH inputs')
      }
      if (publicKey.length !== 33 || !ecc.isPoint(publicKey) ||
          !Buffer.from(crypto.hash160(publicKey)).equals(Buffer.from(ownerHash))) {
        throw new Error(`${segwit ? 'Witness' : 'ScriptSig'} public key does not own the input`)
      }
      const { signature, hashType } = script.signature.decode(encodedSignature)
      if (hashType !== Transaction.SIGHASH_ALL) throw new Error('Fixture only supports SIGHASH_ALL')
      const digest = segwit
        ? tx.hashForWitnessV0(index, payments.p2pkh({ pubkey: publicKey }).output, previous.value, hashType)
        : tx.hashForSignature(index, previous.script, hashType)
      if (!ecc.verify(digest, publicKey, signature, true)) throw new Error('Invalid input signature')
      return { txid, vout: input.index, value: previous.value, address: previous.address }
    })
    const outputs = tx.outs.map((output, index) => ({
      address: this._decodeAddress(output.script),
      value: satoshis(output.value),
      index
    }))
    const inputValue = inputs.reduce((sum, input) => sum + input.value, 0n)
    const outputValue = outputs.reduce((sum, output) => sum + output.value, 0n)
    if (inputValue > MAX_MONEY || outputValue > MAX_MONEY || outputValue > inputValue) {
      throw new Error('Transaction output value exceeds available input value')
    }
    return { txid: tx.getId(), fee: inputValue - outputValue, inputValue, outputValue, inputs, outputs }
  }

  async broadcast (hex) {
    this.calls.push({ method: 'broadcast' })
    const inspected = this.inspectTransaction(hex)
    // Validate the entire spend before mutating any output or history record.
    for (const input of inspected.inputs) {
      if (!this._unspent.has(`${input.txid}:${input.vout}`)) throw new Error('Input already spent')
    }
    if (this._transactions.has(inspected.txid)) throw new Error('Transaction already recorded')
    this._recordTransaction(Transaction.fromHex(hex), 0, inspected.inputs)
    this.broadcasts.push(hex)
    return inspected.txid
  }

  /** @private */
  _decodeAddress (outputScript) {
    try {
      return btcAddress.fromOutputScript(outputScript, this.network)
    } catch {
      // An OP_RETURN or other non-address output is still part of value checks.
      return null
    }
  }

  /** @private */
  _recordTransaction (tx, height, inputs) {
    const txid = tx.getId()
    const addresses = new Set(inputs.map(input => input.address))
    for (const input of inputs) {
      const outpoint = `${input.txid}:${input.vout}`
      this._outputs.get(outpoint).spentBy = txid
      this._unspent.delete(outpoint)
    }
    tx.outs.forEach((output, vout) => {
      const address = this._decodeAddress(output.script)
      if (address) addresses.add(address)
      const outpoint = `${txid}:${vout}`
      this._outputs.set(outpoint, { txid, vout, address, script: output.script, value: output.value, height, spentBy: null })
      this._unspent.add(outpoint)
    })
    this._transactions.set(txid, { hex: tx.toHex(), height, addresses })
  }
}
