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
import test from 'node:test'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { addressAt, createWallet, JsonFileStateStore, randomAddress } from './helpers.js'

test('repeated quotes reserve neither inputs nor change addresses', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const recipient = randomAddress()
  for (let index = 0; index < 5; index++) {
    const quote = await hd.quoteSendTransaction({ to: recipient, value: 10000n, feeRate: 1 })
    assert.ok(quote.fee > 0n)
  }
  assert.deepEqual(await hd.getReservations(), [])
  assert.equal(await hd.getBalance(), 100000n)
  await hd.sendTransaction({ to: recipient, value: 10000n, feeRate: 1 })
  assert.equal(client.inspectTransaction(client.broadcasts[0]).outputs[1].address, addressAt(seed, "0'/1/0"))
})

test('a signed transaction reserves funds durably until the caller explicitly abandons it', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const hex = await hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  const transaction = client.inspectTransaction(hex)
  assert.deepEqual(client.broadcasts, [])
  const reservations = await hd.getReservations()
  assert.equal(reservations.length, 1)
  assert.equal(reservations[0].txid, transaction.txid)
  assert.equal(await hd.getBalance(), 0n)
  assert.equal((await hd.getMaxSpendable({ feeRate: 1 })).amount, 0n)
  wallet.dispose()

  const restored = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client })
  t.after(() => restored.dispose())
  const account = await restored.getHdAccount(0, { ...hdOptions, stateStore: new JsonFileStateStore(store.path) })
  assert.deepEqual(await account.getReservations(), reservations)
  assert.equal(await account.getBalance(), 0n)
  await assert.rejects(account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }))
  // The test discards this raw transaction; real callers must ensure it cannot
  // still be broadcast before they release its inputs.
  await account.releaseReservation(reservations[0].id)
  assert.equal(await account.getBalance(), 100000n)
  await assert.rejects(account.sendTransaction(hex))
  assert.deepEqual(client.broadcasts, [])
  const replacement = await account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  assert.equal(client.inspectTransaction(replacement).outputs[1].address, addressAt(seed, "0'/1/1"))
})

test('signed raw bytes can be broadcast only through their outstanding reservation', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const hex = await hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  const expected = client.inspectTransaction(hex)
  const result = await hd.sendTransaction(hex)
  assert.equal(result.hash, expected.txid)
  assert.equal(result.fee, expected.fee)
  assert.deepEqual(client.broadcasts, [hex])
})

test('concurrent sign and send cannot both reserve the same confirmed outpoint', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const recipient = randomAddress()
  const outcomes = await Promise.allSettled([
    hd.signTransaction({ to: recipient, value: 10000n, feeRate: 1 }),
    hd.sendTransaction({ to: recipient, value: 10000n, feeRate: 1 })
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1)
  assert.ok(client.broadcasts.length <= 1)
  assert.equal(await hd.getBalance(), 0n)
})

test('broadcast acceptance followed by an RPC timeout keeps its reservation and pending change unavailable', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const broadcast = client.broadcast.bind(client)
  client.broadcast = async hex => {
    await broadcast(hex)
    throw new Error('simulated connection lost after broadcast acceptance')
  }
  await assert.rejects(hd.sendTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }), /connection lost/)
  assert.equal(client.broadcasts.length, 1)
  const transaction = client.inspectTransaction(client.broadcasts[0])
  assert.equal((await hd.getReservations()).length, 1)
  assert.equal(await hd.getBalance(), 0n)
  await assert.rejects(hd.sendTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }))
  assert.equal(client.broadcasts.length, 1)
  client.broadcast = broadcast
  client.mine()
  assert.equal(await hd.getBalance(), 90000n - transaction.fee)
})

test('a failed durable write exposes neither a transaction nor a skipped change allocation', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  assert.equal(await hd.getBalance(), 100000n)
  store.failNextWrite = new Error('simulated durable storage unavailable')
  await assert.rejects(hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }), /storage unavailable/)
  assert.deepEqual(client.broadcasts, [])
  assert.deepEqual(await hd.getReservations(), [])
  const hex = await hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  assert.equal(client.inspectTransaction(hex).outputs[1].address, addressAt(seed, "0'/1/0"))
})

test('abandoned change reservations cannot create a seed-restore gap', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  for (let index = 0; index < hdOptions.gapLimit; index++) {
    const hex = await hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
    assert.equal(client.inspectTransaction(hex).outputs[1].address, addressAt(seed, `0'/1/${index}`))
    const [reservation] = await hd.getReservations()
    await hd.releaseReservation(reservation.id)
  }
  await assert.rejects(hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }))
  assert.deepEqual(client.broadcasts, [])
})

test('receiving allocations persist across manager instances and stop before a restore gap', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  assert.equal(await hd.getNewAddress(), addressAt(seed, "0'/0/1"))
  wallet.dispose()
  const restored = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client })
  t.after(() => restored.dispose())
  const account = await restored.getHdAccount(0, { ...hdOptions, stateStore: new JsonFileStateStore(store.path) })
  assert.equal(await account.getNewAddress(), addressAt(seed, "0'/0/2"))
  await assert.rejects(account.getNewAddress())
  // Only confirmed history advances the seed-recovery boundary.
  client.fund(addressAt(seed, "0'/0/2"), 10000n, { confirmed: false })
  await assert.rejects(account.getNewAddress())
  client.mine()
  assert.equal(await account.getNewAddress(), addressAt(seed, "0'/0/3"))
  assert.equal(await account.getAddress(), addressAt(seed, "0'/0/0"))
})
