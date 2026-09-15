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
import test from 'node:test'
import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { networks, payments, Transaction } from 'bitcoinjs-lib'
import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { createStore, createWallet } from './helpers.js'

const bip32 = BIP32Factory(ecc)

// This oracle uses BIP32 and P2PKH payments directly, without account or signer
// derivation helpers. All private material is temporary and cleared after use.
function legacyAddress (seed, path) {
  const root = bip32.fromSeed(seed, networks.regtest)
  let leaf
  try {
    leaf = root.derivePath(`m/44'/1'/${path}`)
    return payments.p2pkh({ pubkey: leaf.publicKey, network: networks.regtest }).address
  } finally {
    leaf?.privateKey.fill(0)
    leaf?.chainCode.fill(0)
    root.privateKey.fill(0)
    root.chainCode.fill(0)
  }
}

function inspectLegacySpend (client, result, hex, { inputValue, amount, recipient, changeAddress, feeRate }) {
  const transaction = Transaction.fromHex(hex)
  const inspected = client.inspectTransaction(hex)
  assert.ok(transaction.ins.every(input => input.witness.length === 0 && input.script.length > 0))
  assert.equal(inspected.txid, result.hash)
  assert.equal(inspected.inputValue, inputValue)
  assert.equal(result.fee, inputValue - inspected.outputs.reduce((sum, output) => sum + output.value, 0n))
  assert.equal(result.fee, inspected.fee)
  assert.ok(result.fee >= BigInt(transaction.virtualSize() * feeRate))
  assert.deepEqual(inspected.outputs, [
    { index: 0, address: recipient, value: amount },
    { index: 1, address: changeAddress, value: inputValue - amount - result.fee }
  ])
  return inspected
}

test('BIP44 rotates change, signs receiving plus change inputs and restores from the seed', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t, { config: { bip: 44 } })
  const hd = await wallet.getHdAccount(0, hdOptions)
  const receiving = [0, 1].map(index => legacyAddress(seed, `0'/0/${index}`))
  const change = [0, 1, 2].map(index => legacyAddress(seed, `0'/1/${index}`))
  const recipientSeed = randomBytes(64)
  let recipient
  try { recipient = legacyAddress(recipientSeed, "0'/0/0") } finally { recipientSeed.fill(0) }
  assert.equal(await hd.getAddress(), receiving[0])
  assert.equal(await hd.getNewAddress(), receiving[1])
  client.fund(receiving[0], 100000n)

  const first = await hd.sendTransaction({ to: recipient, value: 20000n, feeRate: 2 })
  const firstTx = inspectLegacySpend(client, first, client.broadcasts[0], {
    inputValue: 100000n, amount: 20000n, recipient, changeAddress: change[0], feeRate: 2
  })
  assert.deepEqual(firstTx.inputs.map(input => input.address), [receiving[0]])
  client.mine()
  assert.equal(await hd.getBalance(), 80000n - first.fee)

  // Neither individual output can fund this send: both the next receiving key
  // and the first internal change key must sign the same legacy transaction.
  client.fund(receiving[1], 50000n)
  const second = await hd.sendTransaction({ to: recipient, value: 100000n, feeRate: 2 })
  const secondTx = inspectLegacySpend(client, second, client.broadcasts[1], {
    inputValue: 130000n - first.fee, amount: 100000n, recipient, changeAddress: change[1], feeRate: 2
  })
  assert.deepEqual(secondTx.inputs.map(input => input.address).sort(), [receiving[1], change[0]].sort())
  client.mine()
  assert.equal(await hd.getBalance(), 30000n - first.fee - second.fee)
  wallet.dispose()

  const restoredWallet = new WalletManagerBtc(seed, { network: 'regtest', bip: 44, client })
  t.after(() => restoredWallet.dispose())
  // No allocation or reservation records survive into this fresh state store.
  const restored = await restoredWallet.getHdAccount(0, { ...hdOptions, stateStore: await createStore(t) })
  assert.equal(await restored.getBalance(), 30000n - first.fee - second.fee)
  assert.equal(await restored.getAddress(), receiving[0])
  const signed = await restored.signTransaction({ to: recipient, value: 10000n, feeRate: 2 })
  const altered = Transaction.fromHex(signed)
  altered.outs[0].value -= 1n
  await assert.rejects(client.broadcast(altered.toHex()), /Invalid input signature/)
  const third = await restored.sendTransaction(signed)
  const thirdTx = inspectLegacySpend(client, third, client.broadcasts[2], {
    inputValue: 30000n - first.fee - second.fee, amount: 10000n, recipient, changeAddress: change[2], feeRate: 2
  })
  assert.deepEqual(thirdTx.inputs.map(input => input.address), [change[1]])
  client.mine()
  const receipt = await restored.getTransaction(third.hash)
  assert.equal(receipt.finality, 'confirmed')
  assert.equal(receipt.confirmations, 1)
  assert.equal(await restored.getBalance(), 20000n - first.fee - second.fee - third.fee)
  const outgoing = await restored.getTransfers({ direction: 'outgoing', limit: 100 })
  assert.deepEqual(outgoing.map(row => [row.txid, row.recipient, row.value]).sort(), [
    [first.hash, recipient, 20000n], [second.hash, recipient, 100000n], [third.hash, recipient, 10000n]
  ].sort())
})
