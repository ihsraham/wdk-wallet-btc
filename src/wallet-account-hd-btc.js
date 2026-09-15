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
'use strict'

import { address as btcAddress, Psbt, Transaction } from 'bitcoinjs-lib'
import { Output } from '@bitcoinerlab/descriptors'
import * as ecc from '@bitcoinerlab/secp256k1'
import { coinselect } from '@bitcoinerlab/coinselect'
import { ValueError, UnsupportedOperationError, InvalidSignerError, MaximumFeeExceededError, TransactionError, TransactionErrorReason } from '@tetherto/wdk-wallet'

import WalletAccountBtc from './wallet-account-btc.js'
import HdAccountClient from './hd-account-client.js'
import { initialState, validateState, structuredCopy, isIndex, isTxid, satoshis, MAX_MONEY } from './hd-account-state.js'

/** @typedef {import('./signers/signer-btc.js').ISignerBtc} ISignerBtc */
/** @typedef {import('./wallet-account-read-only-btc.js').BtcWalletConfig} BtcWalletConfig */
/** @typedef {import('./hd-account-state.js').HdAccountStateStore} HdAccountStateStore */
/** @typedef {import('./hd-account-state.js').HdReservation} HdReservation */
/**
 * @typedef {Object} HdAccountOptions
 * @property {HdAccountStateStore} stateStore - Dedicated durable atomic storage shared by every writer of this HD account.
 * @property {number} [gapLimit=20] - Consecutive unused addresses that stop discovery and bound outstanding address allocation.
 * @property {number} [maxAddresses=1000] - Maximum addresses scanned per branch. Exhaustion fails explicitly.
 * @property {string} [signerName] - Registered derivable signer selected by the manager.
 */

/** @param {{ tx_hash: string, tx_pos: number }} output @returns {string} */
const outpoint = output => `${output.tx_hash}:${output.tx_pos}`

/** @param {import('./wallet-account-read-only-btc.js').BtcTransaction} transaction */
const snapshotTransaction = ({ to, value, feeRate, confirmationTarget }) => ({ to, value, feeRate, confirmationTarget })

/**
 * Opt-in account covering one HD account root's receiving and change branches.
 * Balance and spending include confirmed, unreserved UTXOs only. Pending change
 * becomes spendable after confirmation. Legacy single-address accounts are unchanged.
 */
export default class WalletAccountHdBtc extends WalletAccountBtc {
  /**
   * Creates an HD account from a borrowed account-root signer. The manager uses this
   * factory with an owned derived root. Callers must not transact through overlapping
   * leaf accounts or use independent reservation stores for the same HD account.
   *
   * @param {ISignerBtc} rootSigner - Derivable signer at the chosen account root.
   * @param {BtcWalletConfig & HdAccountOptions} config - Account, transport and storage options.
   * @param {boolean} [ownsRoot=false] - Whether this account should dispose the root.
   * @returns {Promise<WalletAccountHdBtc>}
   */
  static async create (rootSigner, config, ownsRoot = false) {
    let firstSigner
    let account
    try {
      const { gapLimit = 20, maxAddresses = 1000, stateStore } = config
      if (!rootSigner.isDerivable) throw new UnsupportedOperationError('HD accounts require a derivable signer.')
      if (!isIndex(gapLimit, 1000) || gapLimit < 1 || !isIndex(maxAddresses, 100000) || maxAddresses <= gapLimit ||
        !stateStore || typeof stateStore.load !== 'function' || typeof stateStore.compareAndSwap !== 'function') {
        throw new ValueError('HD accounts require a durable compare-and-swap state store and valid discovery limits.')
      }
      firstSigner = await rootSigner.derive('0/0')
      if (firstSigner === rootSigner) throw new InvalidSignerError('Derivation must return an independently owned child signer.')
      account = new WalletAccountHdBtc(rootSigner, firstSigner, { ...config, gapLimit, maxAddresses }, ownsRoot)
      account._accountId = await firstSigner.getAddress()
      await account._readState()
      return account
    } catch (error) {
      if (account) account.dispose()
      else {
        if (firstSigner && firstSigner !== rootSigner) firstSigner.dispose()
        if (ownsRoot) rootSigner.dispose()
      }
      throw error
    }
  }

  /** @private @param {ISignerBtc} rootSigner @param {ISignerBtc} firstSigner @param {BtcWalletConfig & HdAccountOptions} config @param {boolean} ownsRoot */
  constructor (rootSigner, firstSigner, config, ownsRoot) {
    super(firstSigner, { ...config, shouldWipeSignerOnDisposal: true })
    /** @private */
    this._rootSigner = rootSigner
    /** @private */
    this._ownsRoot = ownsRoot
    /** @private */
    this._stateStore = config.stateStore
    /** @private */
    this._gapLimit = config.gapLimit
    /** @private */
    this._maxAddresses = config.maxAddresses
    /** @private */
    this._accountId = ''
    /** @private */
    this._addresses = new Map()
    /** @private */
    this._operation = Promise.resolve()
    /** @private */
    this._disposed = false
    /** @private */
    this._hdClient = this._client
    /** @protected @type {import('./transports/index.js').IBtcClient} */
    this._client = new HdAccountClient(this._hdClient, () => this._discover())
  }

  /** The HD account root's path, possibly unknown for an imported signer. @returns {string | null} */
  get path () { return this._rootSigner.path }

  /** No single key represents an HD account. @returns {null} */
  get keyPair () { return null }

  /**
   * Stable receiving address at 0/0, also used for message signatures.
   * @returns {Promise<string>}
   */
  async getAddress () {
    this._assertActive()
    return super.getAddress()
  }

  /**
   * Signs a message with receiving address 0/0.
   * @param {string} message - Message to sign.
   * @returns {Promise<string>}
   */
  async sign (message) {
    this._assertActive()
    return super.sign(message)
  }

  /**
   * Reserves and returns a new receiving address. Fails when unused reservations
   * would create a gap that seed-only restoration cannot recover.
   * @returns {Promise<string>}
   */
  async getNewAddress () {
    return this._exclusive(async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const snapshot = await this._discover()
        const index = Math.max(snapshot.state?.nextReceiveIndex ?? 1, snapshot.lastUsed[0] + 1)
        this._checkAllocation(index, snapshot.lastConfirmed[0])
        const entry = await this._deriveAddress(0, index)
        const state = snapshot.state ? structuredCopy(snapshot.state) : initialState(this._accountId)
        state.nextReceiveIndex = index + 1
        if (await this._replace(snapshot.state, state)) return entry.address
      }
      throw new ValueError('HD reservation store remained busy; retry the operation.')
    })
  }

  /** Returns detached public reservation metadata. @returns {Promise<HdReservation[]>} */
  async getReservations () {
    this._assertActive()
    return (await this._readState())?.reservations ?? []
  }

  /**
   * Releases inputs of an explicitly abandoned transaction, without reusing its
   * address index. Only call when its signed bytes will never be broadcast again.
   * Confirmation or a broadcast timeout is not evidence that release is safe.
   * @param {number} id - Reservation ID returned by getReservations().
   * @returns {Promise<void>}
   */
  async releaseReservation (id) {
    if (!isIndex(id, Number.MAX_SAFE_INTEGER - 1)) throw new ValueError('Invalid reservation ID.')
    return this._exclusive(() => this._updateReservation(id, null))
  }

  /**
   * Signs a transaction and retains its durable input and change reservations.
   * @param {import('./wallet-account-read-only-btc.js').BtcTransaction} transaction - Transaction to sign.
   * @returns {Promise<string>}
   */
  async signTransaction (transaction) {
    transaction = snapshotTransaction(transaction)
    return this._exclusive(async () => (await this._prepareTransaction(transaction)).hex)
  }

  /**
   * Quotes the same normalized fee rate used by signing, without reserving inputs
   * or issuing change addresses. The exact signed fee can include dust.
   * @param {import('./wallet-account-read-only-btc.js').BtcTransaction | string} transaction
   * @returns {Promise<Omit<import('@tetherto/wdk-wallet').TransactionResult, 'hash'>>}
   */
  async quoteSendTransaction (transaction) {
    if (typeof transaction !== 'string') transaction = snapshotTransaction(transaction)
    this._assertActive()
    await this._hdClient.connect()
    return super.quoteSendTransaction(typeof transaction === 'string' ? transaction : { ...transaction, feeRate: await this._feeRate(transaction) })
  }

  /**
   * Estimates a spend from confirmed, unreserved outputs using the execution fee
   * rate. This remains an estimate; destination type affects the exact signed fee.
   * @param {{ feeRate?: number | bigint }} [options]
   * @returns {Promise<import('./wallet-account-read-only-btc.js').BtcMaxSpendableResult>}
   */
  async getMaxSpendable ({ feeRate } = {}) {
    this._assertActive()
    await this._hdClient.connect()
    return super.getMaxSpendable({ feeRate: await this._feeRate({ feeRate }) })
  }

  /**
   * Signs and broadcasts a transaction, preserving input reservations on ambiguous
   * submission failure. Raw hex must correspond to a reservation in this store.
   * @param {import('./wallet-account-read-only-btc.js').BtcTransaction | string} transaction
   * @param {number} [timeoutMs] - Retained for signature compatibility; reservation reconciliation replaces polling.
   * @returns {Promise<import('@tetherto/wdk-wallet').TransactionResult>}
   */
  async sendTransaction (transaction, timeoutMs) {
    if (typeof transaction !== 'string') transaction = snapshotTransaction(transaction)
    return this._exclusive(async () => {
      await this._hdClient.connect()
      let built
      if (typeof transaction === 'string') {
        const decoded = Transaction.fromHex(transaction)
        const hash = decoded.getId()
        const state = await this._readState()
        const reservation = state?.reservations.find(item => item.txid === hash)
        const inputs = decoded.ins.map(input => `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`)
        if (!reservation || inputs.length !== reservation.outpoints.length || inputs.some(input => !reservation.outpoints.includes(input))) {
          throw new ValueError('Signed transaction does not belong to an outstanding HD reservation.')
        }
        const fee = await this._getSignedTransactionFee(decoded)
        this._checkFee(fee)
        built = { hex: transaction, hash, fee }
      } else {
        built = await this._prepareTransaction(transaction)
      }
      this._assertActive()
      await this._hdClient.broadcast(built.hex)
      return { hash: built.hash, fee: built.fee }
    })
  }

  /**
   * The draft signer contract has no settled public-only discovery capability.
   * Never return a partial address snapshot or retain a signing root behind a read-only wrapper.
   * @returns {Promise<never>}
   * @throws {UnsupportedOperationError} Always for HD accounts.
   */
  async toReadOnlyAccount () {
    throw new UnsupportedOperationError('HD read-only discovery requires a public-only derivation capability.')
  }

  /** Disposes owned children/root and owned transports. Repeated calls are safe. */
  dispose () {
    if (this._disposed) return
    this._disposed = true
    try {
      if (this._ownsRoot) this._rootSigner.dispose()
    } finally {
      super.dispose()
    }
  }

  /** @private */
  _assertActive () {
    if (this._disposed) throw new InvalidSignerError('The HD account has been disposed.')
  }

  /** @private @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  _exclusive (action) {
    const result = this._operation.then(() => { this._assertActive(); return action() })
    this._operation = result.then(() => undefined, () => undefined)
    return result
  }

  /** @private */
  async _readState () {
    return validateState(await this._stateStore.load(), this._accountId, this._maxAddresses)
  }

  /** @private */
  async _replace (previous, next) {
    this._assertActive()
    next.revision = previous === null ? 0 : previous.revision + 1
    validateState(next, this._accountId, this._maxAddresses)
    const replaced = await this._stateStore.compareAndSwap(previous?.revision ?? null, structuredCopy(next))
    if (typeof replaced !== 'boolean') throw new ValueError('The HD state store must return a boolean from compareAndSwap.')
    this._assertActive()
    return replaced
  }

  /** @private */
  async _deriveAddress (branch, index) {
    this._assertActive()
    const key = `${branch}/${index}`
    if (this._addresses.has(key)) return this._addresses.get(key)
    const signer = await this._rootSigner.derive(key)
    if (signer === this._rootSigner) throw new InvalidSignerError('Derivation must return an independent child signer.')
    try {
      const address = await signer.getAddress()
      this._assertActive()
      const script = Buffer.from(btcAddress.toOutputScript(address, this._network)).toString('hex')
      if (!(this._config.bip === 84 ? /^0014[a-f0-9]{40}$/ : /^76a914[a-f0-9]{40}88ac$/).test(script)) throw new UnsupportedOperationError('Derived addresses must match the HD account BIP-44 or BIP-84 script family.')
      for (const [otherKey, entry] of this._addresses) {
        if (entry.address === address && otherKey !== key) throw new InvalidSignerError('Different HD paths derived the same address.')
      }
      const entry = { address, script, branch, index }
      this._addresses.set(key, entry)
      return entry
    } finally {
      signer.dispose()
    }
  }

  /** @private */
  async _discover () {
    this._assertActive()
    await this._hdClient.connect()
    const state = await this._readState()
    const entries = []
    const outputs = new Map()
    const history = new Map()
    const lastUsed = [-1, -1]
    const lastConfirmed = [-1, -1]
    for (const branch of [0, 1]) {
      const issued = branch === 0 ? (state?.nextReceiveIndex ?? 1) : (state?.nextChangeIndex ?? 0)
      let gap = 0
      let complete = false
      for (let index = 0; index < this._maxAddresses; index++) {
        const entry = await this._deriveAddress(branch, index)
        const [items, unspent] = await Promise.all([this._hdClient.getHistory(entry.address), this._hdClient.listUnspent(entry.address)])
        this._assertActive()
        if (!Array.isArray(items) || !Array.isArray(unspent)) throw new ValueError('Invalid HD discovery response: expected history and unspent arrays.')
        let confirmed = false
        for (const item of items) {
          if (!item || !isTxid(item.tx_hash) || !Number.isSafeInteger(item.height)) throw new ValueError('Invalid transaction history during HD discovery.')
          const hash = item.tx_hash.toLowerCase()
          confirmed ||= item.height > 0
          const previous = history.get(hash)
          history.set(hash, { tx_hash: hash, height: previous ? Math.min(previous.height, item.height) : item.height })
        }
        for (const item of unspent) {
          if (!item || !isTxid(item.tx_hash) || !isIndex(item.tx_pos, 0xffffffff) || !Number.isSafeInteger(item.height)) throw new ValueError('Invalid unspent output during HD discovery.')
          const value = Number(satoshis(item.value))
          const output = { tx_hash: item.tx_hash.toLowerCase(), tx_pos: item.tx_pos, height: item.height, value, address: entry.address, script: entry.script, branch, index }
          const previous = outputs.get(outpoint(output))
          if (previous && (previous.address !== output.address || previous.value !== value || previous.height !== output.height)) throw new ValueError('Conflicting Bitcoin output data during HD discovery.')
          outputs.set(outpoint(output), output)
          confirmed ||= item.height > 0
        }
        entries.push(entry)
        if (confirmed) lastConfirmed[branch] = index
        if (items.length || unspent.length) { lastUsed[branch] = index; gap = 0 } else { gap++ }
        if (gap >= this._gapLimit && index + 1 >= issued) { complete = true; break }
      }
      if (!complete) throw new ValueError('HD discovery exceeded maxAddresses before finding a complete unused gap.')
    }
    const reserved = new Set((state?.reservations ?? []).flatMap(item => item.outpoints))
    const allOutputs = [...outputs.values()]
    const available = allOutputs.filter(item => item.height > 0 && !reserved.has(outpoint(item)))
    if (allOutputs.reduce((sum, item) => sum + BigInt(item.value), 0n) > MAX_MONEY) throw new ValueError('HD balance exceeds the maximum Bitcoin supply.')
    return { state, entries, outputs: allOutputs, available, lastUsed, lastConfirmed, history: [...history.values()].sort((a, b) => (b.height <= 0 ? Infinity : b.height) - (a.height <= 0 ? Infinity : a.height) || a.tx_hash.localeCompare(b.tx_hash)) }
  }

  /** @private */
  _checkAllocation (index, lastConfirmed) {
    if (index >= this._maxAddresses || index > lastConfirmed + this._gapLimit) throw new ValueError('Unused HD address gap exhausted; wait for confirmation before allocating more addresses.')
  }

  /** @private */
  async _feeRate (transaction) {
    if (transaction.confirmationTarget !== undefined && (!isIndex(transaction.confirmationTarget) || transaction.confirmationTarget < 1)) throw new ValueError('Invalid confirmation target.')
    const requested = transaction.feeRate ?? Math.max((await this._hdClient.estimateFee(transaction.confirmationTarget ?? 1)) * 100000, 1)
    if (!['number', 'bigint'].includes(typeof requested) || !Number.isFinite(Number(requested)) || requested <= 0 || requested > Number.MAX_SAFE_INTEGER) throw new ValueError('Invalid Bitcoin fee rate.')
    const rounded = this._toBigInt(requested)
    return rounded < 1n ? 1n : rounded
  }

  /** @private */
  _planHdSpend (available, to, value, feeRate, changeAddress) {
    const amount = satoshis(value)
    if (amount <= this._dustLimit) throw new ValueError('The amount must exceed the dust limit.')
    const network = this._network
    const result = available.length
      ? coinselect({
        utxos: available.map(item => ({ output: new Output({ descriptor: `addr(${item.address})`, network }), value: BigInt(item.value), ref: item })),
        remainder: new Output({ descriptor: `addr(${changeAddress})`, network }),
        targets: [{ output: new Output({ descriptor: `addr(${to})`, network }), value: amount }],
        feeRate: Number(feeRate)
      })
      : null
    if (!result) throw new TransactionError('Insufficient confirmed, unreserved Bitcoin balance.', { reason: TransactionErrorReason.INSUFFICIENT_BALANCE })
    if (result.utxos.length > 200) throw new ValueError('Exceeded maximum allowed inputs for transaction.')
    const utxos = result.utxos.map(({ ref }) => ({ ...ref, vout: { value: BigInt(ref.value), scriptPubKey: { hex: ref.script } } }))
    const total = utxos.reduce((sum, item) => sum + item.vout.value, 0n)
    let fee = result.fee > 141n ? result.fee : 141n
    let changeValue = total - amount - fee
    if (changeValue < 0n) throw new TransactionError('Insufficient balance after fees.', { reason: TransactionErrorReason.INSUFFICIENT_BALANCE })
    if (changeValue <= this._dustLimit) { fee += changeValue; changeValue = 0n }
    return { utxos, fee, changeValue }
  }

  /**
   * @protected
   * @param {{ fromAddress: string, toAddress: string, amount: number | bigint, feeRate: number | bigint }} transaction
   * @returns {Promise<import('./wallet-account-read-only-btc.js').BtcSpendPlan>}
   */
  async _planSpend ({ toAddress, amount, feeRate }) {
    const snapshot = await this._discover()
    return this._planHdSpend(snapshot.available, toAddress, amount, feeRate, this._accountId)
  }

  /** @private */
  _checkFee (fee) {
    if (fee < 0n) throw new ValueError('Invalid signed transaction fee.')
    if (this._config.transactionMaxFee !== undefined && fee > this._config.transactionMaxFee) throw new MaximumFeeExceededError('Exceeded maximum fee cost for transaction operation.')
  }

  /** @private */
  async _prepareTransaction (transaction) {
    this._assertActive()
    await this._hdClient.connect()
    const feeRate = await this._feeRate(transaction)
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await this._discover()
      const state = snapshot.state ? structuredCopy(snapshot.state) : initialState(this._accountId)
      // Keep signed inputs reserved across confirmations: a reorg can resurrect them.
      const plan = this._planHdSpend(snapshot.available, transaction.to, transaction.value, feeRate, this._accountId)
      this._checkFee(plan.fee)
      await this._validatePrevouts(plan.utxos)
      let changeAddress
      let changeIndex = null
      if (plan.changeValue > 0n) {
        changeIndex = Math.max(state.nextChangeIndex, snapshot.lastUsed[1] + 1)
        this._checkAllocation(changeIndex, snapshot.lastConfirmed[1])
        changeAddress = (await this._deriveAddress(1, changeIndex)).address
        state.nextChangeIndex = changeIndex + 1
      }
      const id = snapshot.state ? snapshot.state.revision + 1 : 0
      state.reservations.push({ id, outpoints: plan.utxos.map(outpoint), changeIndex, txid: null })
      if (!await this._replace(snapshot.state, state)) continue
      let built
      try {
        this._assertActive()
        const raw = await this._getRawTransaction({ ...plan, to: transaction.to, value: transaction.value, feeRate, changeAddress })
        const decoded = Transaction.fromHex(raw.hex)
        const fee = plan.utxos.reduce((sum, item) => sum + item.vout.value, 0n) - decoded.outs.reduce((sum, output) => sum + output.value, 0n)
        this._checkFee(fee)
        if (decoded.outs[0].value !== satoshis(transaction.value)) throw new ValueError('Insufficient change to pay the final fee without reducing the requested recipient amount.')
        if (fee < BigInt(decoded.virtualSize()) * feeRate) throw new ValueError('The signed Bitcoin transaction does not meet the requested fee rate.')
        built = { hex: raw.hex, hash: decoded.getId(), fee }
      } catch (error) {
        // No signed bytes escaped this operation. Burn the address, but release inputs.
        // If persistence itself fails, keep the durable reservation rather than hiding that error.
        await this._updateReservation(id, null)
        throw error
      }
      await this._updateReservation(id, built.hash)
      return built
    }
    throw new ValueError('HD reservation store remained busy; retry the operation.')
  }

  /** Verifies selected provider data against the transaction committed by its hash. @private */
  async _validatePrevouts (utxos) {
    const transactions = new Map()
    for (const utxo of utxos) {
      if (!transactions.has(utxo.tx_hash)) transactions.set(utxo.tx_hash, Transaction.fromHex(await this._hdClient.getTransaction(utxo.tx_hash)))
      const transaction = transactions.get(utxo.tx_hash)
      const output = transaction.outs[utxo.tx_pos]
      if (transaction.getId() !== utxo.tx_hash || !output || output.value !== BigInt(utxo.value) || Buffer.from(output.script).toString('hex') !== utxo.script) throw new ValueError('Provider returned inconsistent previous Bitcoin output data.')
    }
  }

  /** @private */
  async _updateReservation (id, txid) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const previous = await this._readState()
      if (!previous || !previous.reservations.some(item => item.id === id)) throw new ValueError('HD reservation no longer exists.')
      const state = structuredCopy(previous)
      if (txid === null) state.reservations = state.reservations.filter(item => item.id !== id)
      else state.reservations.find(item => item.id === id).txid = txid
      if (await this._replace(previous, state)) return
    }
    throw new ValueError('HD reservation store remained busy; retry the operation.')
  }

  /** @protected @param {Psbt} psbt @returns {Promise<string>} */
  async _signPsbt (psbt) {
    this._assertActive()
    const intent = Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer()).toString('hex')
    const fingerprint = input => input.witnessUtxo ? `${Buffer.from(input.witnessUtxo.script).toString('hex')}:${input.witnessUtxo.value}` : Buffer.from(input.nonWitnessUtxo ?? []).toString('hex')
    const previousOutputs = psbt.data.inputs.map(fingerprint)
    const scripts = new Set(psbt.data.inputs.map((input, index) => {
      if (input.witnessUtxo) return Buffer.from(input.witnessUtxo.script).toString('hex')
      if (input.nonWitnessUtxo) return Buffer.from(Transaction.fromBuffer(input.nonWitnessUtxo).outs[psbt.txInputs[index].index].script).toString('hex')
      throw new ValueError('Missing previous output for HD signing.')
    }))
    for (const script of scripts) {
      const entry = [...this._addresses.values()].find(item => item.script === script)
      if (!entry) throw new InvalidSignerError('Selected Bitcoin input is outside the discovered HD account.')
      const signer = await this._rootSigner.derive(`${entry.branch}/${entry.index}`)
      if (signer === this._rootSigner) throw new InvalidSignerError('Derivation must return an independent child signer.')
      try {
        this._assertActive()
        psbt = Psbt.fromBase64(await signer.signPsbt(psbt))
        this._assertActive()
        if (psbt.data.inputs.some((input, index) => fingerprint(input) !== previousOutputs[index])) throw new InvalidSignerError('Signer changed the verified previous output data.')
        if (Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer()).toString('hex') !== intent) throw new InvalidSignerError('Signer changed the requested Bitcoin transaction.')
      } finally {
        signer.dispose()
      }
    }
    if (psbt.data.inputs.some(input => !input.partialSig?.length || input.partialSig.some(({ signature }) => signature[signature.length - 1] !== Transaction.SIGHASH_ALL))) throw new InvalidSignerError('HD transactions require complete SIGHASH_ALL signatures.')
    if (!psbt.validateSignaturesOfAllInputs((publicKey, hash, signature) => ecc.verify(hash, publicKey, signature))) throw new InvalidSignerError('Signer returned an invalid Bitcoin signature.')
    return psbt.toBase64()
  }

  /** Validates each provider transaction before computing a signed fee. @protected @param {Transaction} transaction @returns {Promise<bigint>} */
  async _getSignedTransactionFee (transaction) {
    let totalInput = 0n
    for (const input of transaction.ins) {
      const hash = Buffer.from(input.hash).reverse().toString('hex')
      const previous = Transaction.fromHex(await this._hdClient.getTransaction(hash))
      const output = previous.outs[input.index]
      if (previous.getId() !== hash || !output) throw new ValueError('Invalid previous transaction in signed Bitcoin fee calculation.')
      totalInput += output.value
    }
    const fee = totalInput - transaction.outs.reduce((sum, output) => sum + output.value, 0n)
    if (fee < 0n) throw new ValueError('Invalid signed Bitcoin transaction values.')
    return fee
  }

  /**
   * Returns external incoming/outgoing transfer rows across both branches.
   * Internal change/self-transfers are omitted. Fees describe the whole transaction.
   * @param {{ direction?: 'all' | 'incoming' | 'outgoing', limit?: number, skip?: number }} [options]
   * @returns {Promise<import('./wallet-account-btc.js').BtcTransfer[]>}
   */
  async getTransfers ({ direction = 'all', limit = 10, skip = 0 } = {}) {
    if (!['all', 'incoming', 'outgoing'].includes(direction) || !isIndex(limit, 10000) || !isIndex(skip, Number.MAX_SAFE_INTEGER)) throw new ValueError('Invalid HD transfer pagination.')
    if (limit === 0) return []
    const snapshot = await this._discover()
    const owned = new Map(snapshot.entries.map(entry => [entry.script, entry.address]))
    const transactions = new Map()
    const fetch = async hash => {
      if (!transactions.has(hash)) transactions.set(hash, Transaction.fromHex(await this._hdClient.getTransaction(hash)))
      const tx = transactions.get(hash)
      if (tx.getId() !== hash) throw new ValueError('Provider returned a different Bitcoin transaction.')
      return tx
    }
    const rows = []
    for (const item of snapshot.history) {
      const transaction = await fetch(item.tx_hash)
      let totalInput = 0n
      let outgoing = false
      let coinbase = false
      for (const input of transaction.ins) {
        const hash = Buffer.from(input.hash).reverse().toString('hex')
        if (hash === '0'.repeat(64)) { coinbase = true; continue }
        const previous = (await fetch(hash)).outs[input.index]
        if (!previous) throw new ValueError('Missing previous Bitcoin output in transfer history.')
        totalInput += previous.value
        outgoing ||= owned.has(Buffer.from(previous.script).toString('hex'))
      }
      const totalOutput = transaction.outs.reduce((sum, output) => sum + output.value, 0n)
      const fee = coinbase ? undefined : totalInput - totalOutput
      if (fee !== undefined && fee < 0n) throw new ValueError('Invalid transaction values in HD transfer history.')
      for (const [vout, output] of transaction.outs.entries()) {
        const ownAddress = owned.get(Buffer.from(output.script).toString('hex'))
        const rowDirection = outgoing ? (ownAddress ? null : 'outgoing') : (ownAddress ? 'incoming' : null)
        if (!rowDirection || (direction !== 'all' && direction !== rowDirection)) continue
        let recipient
        try { recipient = btcAddress.fromOutputScript(output.script, this._network) } catch { recipient = undefined }
        rows.push({ txid: item.tx_hash, height: item.height, value: output.value, vout, direction: rowDirection, recipient, fee, address: ownAddress ?? this._accountId })
        if (rows.length >= skip + limit) return rows.slice(skip)
      }
    }
    return rows.slice(skip, skip + limit)
  }
}
