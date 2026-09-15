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

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { networks, payments, Psbt, script, Transaction } from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { InMemoryBitcoinClient } from './bitcoin-client.js'

function signer (t, bip = 84) {
  let privateKey
  do { privateKey = randomBytes(32) } while (!ecc.isPrivate(privateKey))
  t.after(() => privateKey.fill(0))
  const publicKey = ecc.pointFromScalar(privateKey, true)
  const payment = (bip === 44 ? payments.p2pkh : payments.p2wpkh)({ pubkey: publicKey, network: networks.regtest })
  return { publicKey, address: payment.address, output: payment.output, sign: hash => ecc.sign(hash, privateKey) }
}

function signedSpend (funding, owner, outputs) {
  const psbt = new Psbt({ network: networks.regtest })
  for (const input of funding) {
    psbt.addInput({ hash: input.txid, index: input.vout ?? 0, witnessUtxo: { script: owner.output, value: input.value } })
  }
  for (const output of outputs) psbt.addOutput(output)
  psbt.signAllInputs(owner)
  psbt.finalizeAllInputs()
  return psbt.extractTransaction().toHex()
}

// The PSBT implementation signs legacy inputs independently of the fixture's
// hashForSignature verifier, using full previous transactions as required.
async function signedLegacySpend (client, txid, owner, outputs) {
  const psbt = new Psbt({ network: networks.regtest })
  psbt.addInput({ hash: txid, index: 0, nonWitnessUtxo: Buffer.from(await client.getTransaction(txid), 'hex') })
  for (const output of outputs) psbt.addOutput(output)
  psbt.signAllInputs(owner)
  psbt.finalizeAllInputs()
  return psbt.extractTransaction().toHex()
}

test('funding, fee units and mining expose exact IBtcClient records', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  await client.connect()
  assert.equal(client.isConnected, true)
  assert.equal(await client.estimateFee(1), 0.00002)
  const confirmed = client.fund(owner.address, 100000n)
  const pending = client.fund(owner.address, 20000n, { confirmed: false })
  assert.notEqual(confirmed, pending)
  assert.deepEqual(await client.getBalance(owner.address), { confirmed: 100000, unconfirmed: 20000 })
  assert.deepEqual(await client.listUnspent(owner.address), [
    { tx_hash: confirmed, tx_pos: 0, value: 100000, height: 100 },
    { tx_hash: pending, tx_pos: 0, value: 20000, height: 0 }
  ])
  assert.deepEqual(await client.getHistory(owner.address), [
    { tx_hash: confirmed, height: 100 }, { tx_hash: pending, height: 0 }
  ])
  assert.equal(Transaction.fromHex(await client.getTransaction(confirmed)).outs[0].value, 100000n)
  assert.equal(client.mine(), 101)
  assert.equal(await client.getBlockHeight(), 101)
  assert.deepEqual(await client.getBalance(owner.address), { confirmed: 120000, unconfirmed: 0 })
  assert.deepEqual(await client.getHistory(owner.address), [
    { tx_hash: confirmed, height: 100 }, { tx_hash: pending, height: 101 }
  ])
  assert.ok(client.calls.some(call => call.method === 'listUnspent' && call.address === owner.address))
  await client.close()
  assert.equal(client.isConnected, false)
  await client.reconnect()
  assert.equal(client.isConnected, true)
})

test('real signatures consume inputs and create pending outputs, fees and history', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  const recipient = signer(t)
  const txid = client.fund(owner.address, 100000n)
  const hex = signedSpend([{ txid, value: 100000n }], owner, [
    { address: recipient.address, value: 60000n }, { address: owner.address, value: 39000n }
  ])
  const inspection = client.inspectTransaction(hex)
  assert.equal(inspection.fee, 1000n)
  assert.equal(inspection.inputValue, 100000n)
  assert.equal(inspection.outputValue, 99000n)
  assert.deepEqual(inspection.inputs, [{ txid, vout: 0, value: 100000n, address: owner.address }])
  assert.deepEqual(inspection.outputs, [
    { index: 0, address: recipient.address, value: 60000n },
    { index: 1, address: owner.address, value: 39000n }
  ])
  const spent = await client.broadcast(hex)
  assert.equal(spent, Transaction.fromHex(hex).getId())
  assert.deepEqual(client.broadcasts, [hex])
  assert.deepEqual(client.inspectTransaction(hex), inspection)
  assert.deepEqual(await client.listUnspent(owner.address), [{ tx_hash: spent, tx_pos: 1, value: 39000, height: 0 }])
  assert.deepEqual(await client.getBalance(owner.address), { confirmed: 100000, unconfirmed: -61000 })
  assert.deepEqual(await client.getBalance(recipient.address), { confirmed: 0, unconfirmed: 60000 })
  assert.deepEqual(await client.getHistory(owner.address), [{ tx_hash: txid, height: 100 }, { tx_hash: spent, height: 0 }])
  assert.deepEqual(await client.getHistory(recipient.address), [{ tx_hash: spent, height: 0 }])
  client.mine()
  assert.deepEqual(await client.getBalance(owner.address), { confirmed: 39000, unconfirmed: 0 })
  assert.deepEqual(await client.getBalance(recipient.address), { confirmed: 60000, unconfirmed: 0 })
})

test('invalid signatures are rejected without consuming funds or recording a broadcast', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  const recipient = signer(t)
  const txid = client.fund(owner.address, 100000n)
  const valid = signedSpend([{ txid, value: 100000n }], owner, [{ address: recipient.address, value: 99000n }])
  const altered = Transaction.fromHex(valid)
  altered.outs[0].value -= 1n // The original signature no longer commits to this output.
  await assert.rejects(client.broadcast(altered.toHex()), /Invalid input signature/)
  assert.deepEqual(client.broadcasts, [])
  assert.deepEqual(await client.listUnspent(owner.address), [{ tx_hash: txid, tx_pos: 0, value: 100000, height: 100 }])
  assert.deepEqual(await client.getHistory(recipient.address), [])
  assert.equal(await client.broadcast(valid), Transaction.fromHex(valid).getId())
})

test('a different valid transaction cannot spend an already consumed input', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  const recipient = signer(t)
  const txid = client.fund(owner.address, 100000n)
  const first = signedSpend([{ txid, value: 100000n }], owner, [{ address: recipient.address, value: 99000n }])
  const conflict = signedSpend([{ txid, value: 100000n }], owner, [{ address: recipient.address, value: 98000n }])
  await client.broadcast(first)
  await assert.rejects(client.broadcast(conflict), /Input already spent/)
  assert.deepEqual(client.broadcasts, [first])
  assert.deepEqual(await client.getBalance(recipient.address), { confirmed: 0, unconfirmed: 99000 })
})

test('the signature digest uses the stored input value, not the signer-supplied amount', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  const recipient = signer(t)
  const txid = client.fund(owner.address, 100000n)
  const wrongValue = signedSpend([{ txid, value: 110000n }], owner, [{ address: recipient.address, value: 99000n }])
  await assert.rejects(client.broadcast(wrongValue), /Invalid input signature/)
  assert.deepEqual(client.broadcasts, [])
})

test('a valid signature from another key cannot spend the funded output', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  const other = signer(t)
  const txid = client.fund(owner.address, 100000n)
  const wrongOwner = signedSpend([{ txid, value: 100000n }], other, [{ address: other.address, value: 99000n }])
  await assert.rejects(client.broadcast(wrongOwner), /Witness public key does not own the input/)
  assert.deepEqual(await client.listUnspent(owner.address), [{ tx_hash: txid, tx_pos: 0, value: 100000, height: 100 }])
  assert.deepEqual(client.broadcasts, [])
})

test('a later invalid input cannot partially consume an earlier valid input', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t)
  const recipient = signer(t)
  const first = client.fund(owner.address, 60000n)
  const second = client.fund(owner.address, 40000n)
  const hex = signedSpend([{ txid: first, value: 60000n }, { txid: second, value: 40000n }], owner, [
    { address: recipient.address, value: 99000n }
  ])
  const altered = Transaction.fromHex(hex)
  altered.ins[1].witness = []
  await assert.rejects(client.broadcast(altered.toHex()), /Invalid P2WPKH witness/)
  assert.deepEqual((await client.listUnspent(owner.address)).map(output => output.tx_hash), [first, second])
  assert.deepEqual(client.broadcasts, [])
  assert.equal(await client.broadcast(hex), Transaction.fromHex(hex).getId())
})

test('legacy signatures commit to outputs and reject tampering without spending funds', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t, 44)
  const recipient = signer(t, 44)
  const txid = client.fund(owner.address, 100000n)
  const valid = await signedLegacySpend(client, txid, owner, [
    { address: recipient.address, value: 60000n }, { address: owner.address, value: 39000n }
  ])
  const altered = Transaction.fromHex(valid)
  assert.equal(altered.ins[0].witness.length, 0)
  assert.equal(script.decompile(altered.ins[0].script).length, 2)
  altered.outs[0].value -= 1n
  await assert.rejects(client.broadcast(altered.toHex()), /Invalid input signature/)
  assert.deepEqual(client.broadcasts, [])
  assert.deepEqual(await client.listUnspent(owner.address), [{ tx_hash: txid, tx_pos: 0, value: 100000, height: 100 }])
  const inspection = client.inspectTransaction(valid)
  assert.equal(inspection.fee, 1000n)
  assert.deepEqual(inspection.inputs, [{ txid, vout: 0, value: 100000n, address: owner.address }])
  assert.equal(await client.broadcast(valid), inspection.txid)
  client.mine()
  assert.deepEqual(await client.getBalance(owner.address), { confirmed: 39000, unconfirmed: 0 })
})

test('legacy verification rejects foreign keys, malformed scriptSig and repeated spends', async t => {
  const client = new InMemoryBitcoinClient()
  const owner = signer(t, 44)
  const other = signer(t, 44)
  const txid = client.fund(owner.address, 100000n)
  const valid = await signedLegacySpend(client, txid, owner, [{ address: other.address, value: 99000n }])
  const wrongKey = Transaction.fromHex(valid)
  const [signature] = script.decompile(wrongKey.ins[0].script)
  wrongKey.ins[0].script = script.compile([signature, other.publicKey])
  await assert.rejects(client.broadcast(wrongKey.toHex()), /ScriptSig public key does not own the input/)
  const malformed = Transaction.fromHex(valid)
  malformed.ins[0].script = script.compile([signature])
  await assert.rejects(client.broadcast(malformed.toHex()), /Invalid P2PKH scriptSig/)
  assert.deepEqual(client.broadcasts, [])
  await client.broadcast(valid)
  const conflict = await signedLegacySpend(client, txid, owner, [{ address: other.address, value: 98000n }])
  await assert.rejects(client.broadcast(conflict), /Input already spent/)
  assert.deepEqual(client.broadcasts, [valid])
})
