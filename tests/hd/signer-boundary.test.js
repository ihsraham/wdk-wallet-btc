// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import * as ecc from '@bitcoinerlab/secp256k1'
import { networks, Psbt, script } from 'bitcoinjs-lib'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import SeedSignerBtc from '../../src/signers/seed-signer-btc.js'
import { InMemoryBitcoinClient } from './bitcoin-client.js'
import { addressAt, AsyncSigner, createStore, randomAddress } from './helpers.js'

const verifySignature = (publicKey, hash, signature) => ecc.verify(hash, publicKey, signature)

class MutatingSigner extends AsyncSigner {
  constructor (delegate, mutate, observations) {
    super(delegate, observations)
    this.mutate = mutate
  }

  async derive (path) {
    return new MutatingSigner(await this.delegate.derive(path), this.mutate, this.observations)
  }

  async signPsbt (input) {
    const psbt = Psbt.fromBase64(typeof input === 'string' ? input : input.toBase64())
    return this.mutate(psbt, this.delegate)
  }
}

function withChangedOutput (psbt) {
  const changed = new Psbt({ network: networks.regtest })
  changed.setVersion(psbt.version)
  changed.setLocktime(psbt.locktime)
  for (const [index, input] of psbt.txInputs.entries()) changed.addInput({ ...input, ...psbt.data.inputs[index] })
  for (const [index, output] of psbt.txOutputs.entries()) {
    changed.addOutput({ script: output.script, value: output.value - (index === 0 ? 1n : 0n) })
  }
  return changed
}

for (const mutation of ['output', 'previous-output value', 'signature']) {
  test(`a signer returning altered ${mutation} data is rejected before signed bytes escape`, async t => {
    const seed = randomBytes(64)
    t.after(() => seed.fill(0))
    let mutations = 0
    const mutate = async (psbt, delegate) => {
      if (mutation === 'output') psbt = withChangedOutput(psbt)
      if (mutation === 'previous-output value') psbt.data.inputs[0].witnessUtxo.value += 1n
      const signed = Psbt.fromBase64(await delegate.signPsbt(psbt))
      assert.equal(signed.validateSignaturesOfAllInputs(verifySignature), true, 'the fixture must first produce real signatures')
      if (mutation === 'signature') {
        const partial = signed.data.inputs[0].partialSig[0]
        const decoded = script.signature.decode(partial.signature)
        const invalid = Uint8Array.from(decoded.signature)
        invalid[31] ^= 1 // Change the scalar while preserving valid DER structure.
        partial.signature = script.signature.encode(invalid, decoded.hashType)
        assert.equal(signed.validateSignaturesOfAllInputs(verifySignature), false)
      }
      // Each payload still finalizes and serializes. Rejection must come from the
      // account's signer boundary, not a broken test double or malformed PSBT.
      const finalized = Psbt.fromBase64(signed.toBase64())
      finalized.finalizeAllInputs()
      assert.equal(typeof finalized.extractTransaction().toHex(), 'string')
      mutations++
      return signed.toBase64()
    }
    const signer = new MutatingSigner(new SeedSignerBtc(seed, "m/84'/1'", { network: 'regtest', bip: 84 }), mutate)
    t.after(() => signer.dispose())
    const client = new InMemoryBitcoinClient()
    const wallet = new WalletManagerBtc(signer, { network: 'regtest', bip: 84, client })
    t.after(() => wallet.dispose())
    const account = await wallet.getHdAccount(0, { gapLimit: 3, maxAddresses: 50, stateStore: await createStore(t) })
    client.fund(addressAt(seed, "0'/0/0"), 100000n)
    await assert.rejects(account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }))
    assert.equal(mutations, 1, 'the signer must return exactly one well-formed altered payload')
    assert.deepEqual(client.broadcasts, [])
    assert.deepEqual(await account.getReservations(), [])
    assert.equal(await account.getBalance(), 100000n)
  })
}
