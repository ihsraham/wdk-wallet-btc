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

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import {
  addressAt,
  asynchronousRoot,
  createStore,
  createWallet,
  JsonFileStateStore,
  randomAddress
} from './helpers.js'
import { InMemoryBitcoinClient } from './bitcoin-client.js'

test('HD address ownership aggregates both branches without changing legacy address accounts', async (t) => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  assert.equal(await wallet.getHdAccountByPath("0'", hdOptions), hd)
  const legacy = await wallet.getAccount(0)
  assert.notEqual(hd, legacy)
  assert.equal(await hd.getAddress(), addressAt(seed, "0'/0/0"))
  assert.equal(await legacy.getAddress(), addressAt(seed, "0'/0/0"))
  assert.equal((await wallet.getAccount(1)).path, "m/84'/1'/0'/0/1")

  const deposits = [
    ["0'/0/0", 25000n],
    ["0'/0/1", 30000n],
    ["0'/1/0", 45000n]
  ].map(([path, amount]) => ({ txid: client.fund(addressAt(seed, path), amount), amount }))

  assert.equal(await hd.getBalance(), 100000n)
  assert.equal(await legacy.getBalance(), 25000n)
  const transfers = await hd.getTransfers({ limit: 100 })
  assert.equal(transfers.length, 3)
  assert.deepEqual(
    transfers.map(row => [row.txid, row.direction, row.value]).sort(),
    deposits.map(({ txid, amount }) => [txid, 'incoming', amount]).sort()
  )

  const maximum = await hd.getMaxSpendable({ feeRate: 1 })
  assert.equal(maximum.amount + maximum.fee + maximum.changeValue, 100000n)
  assert.ok(maximum.amount > 45000n, 'maximum must include more than the largest individual address')
})

test('successive spends rotate internal change and can spend change without external funds', async (t) => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  const receiving = addressAt(seed, "0'/0/0")
  client.fund(receiving, 100000n)
  const recipient = randomAddress()

  const first = await hd.sendTransaction({ to: recipient, value: 10000n, feeRate: 1 })
  const firstTx = client.inspectTransaction(client.broadcasts[0])
  assert.equal(first.hash, firstTx.txid)
  assert.equal(first.fee, firstTx.fee)
  assert.deepEqual(firstTx.outputs.map(({ address }) => address), [recipient, addressAt(seed, "0'/1/0")])
  client.mine()

  const second = await hd.sendTransaction({ to: recipient, value: 12000n, feeRate: 1 })
  const secondTx = client.inspectTransaction(client.broadcasts[1])
  assert.equal(second.hash, secondTx.txid)
  assert.equal(second.fee, secondTx.fee)
  assert.deepEqual(secondTx.inputs.map(({ address }) => address), [addressAt(seed, "0'/1/0")])
  assert.deepEqual(secondTx.outputs.map(({ address }) => address), [recipient, addressAt(seed, "0'/1/1")])
  assert.equal(await hd.getAddress(), receiving)
  client.mine()
  assert.equal(await hd.getBalance(), 78000n - first.fee - second.fee)

  const outgoing = await hd.getTransfers({ direction: 'outgoing', limit: 100 })
  assert.deepEqual(
    outgoing.map(row => [row.txid, row.recipient, row.value]).sort(),
    [[first.hash, recipient, 10000n], [second.hash, recipient, 12000n]].sort()
  )
})

test('a spend signs inputs from multiple receiving and internal leaf keys', async (t) => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  const sources = ["0'/0/0", "0'/0/1", "0'/1/0"].map(path => addressAt(seed, path))
  for (const source of sources) client.fund(source, 25000n)

  const result = await hd.sendTransaction({ to: randomAddress(), value: 65000n, feeRate: 1 })
  const transaction = client.inspectTransaction(client.broadcasts[0])
  assert.equal(transaction.inputs.length, 3)
  assert.deepEqual(transaction.inputs.map(input => input.address).sort(), sources.sort())
  assert.equal(transaction.inputValue, 75000n)
  assert.equal(transaction.fee, result.fee)
  assert.equal(transaction.outputValue + result.fee, 75000n)
})

test('seed-only recovery rediscovers funded change and avoids its used index', async (t) => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 60000n)
  const first = await hd.sendTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  client.mine()
  wallet.dispose()

  const restoredWallet = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client })
  t.after(() => restoredWallet.dispose())
  const restored = await restoredWallet.getHdAccount(0, { ...hdOptions, stateStore: await createStore(t) })
  assert.equal(await restored.getBalance(), 50000n - first.fee)
  const recipient = randomAddress()
  await restored.sendTransaction({ to: recipient, value: 10000n, feeRate: 1 })
  assert.deepEqual(
    client.inspectTransaction(client.broadcasts[1]).outputs.map(output => output.address),
    [recipient, addressAt(seed, "0'/1/1")]
  )
})

test('two manager instances sharing atomic durable state reserve different inputs and change', { timeout: 10000 }, async (t) => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const otherWallet = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client })
  t.after(() => otherWallet.dispose())
  const first = await wallet.getHdAccount(0, hdOptions)
  const otherStore = new JsonFileStateStore(store.path)
  const second = await otherWallet.getHdAccountByPath("0'", {
    ...hdOptions,
    stateStore: otherStore
  })
  client.fund(addressAt(seed, "0'/0/0"), 80000n)
  client.fund(addressAt(seed, "0'/0/1"), 80000n)
  const recipient = randomAddress()

  // Hold both writes until each writer has selected against the same revision.
  // Without this barrier, a favorable schedule could hide missing CAS behavior.
  const initialRevision = (await store.load())?.revision ?? null
  let arrivals = 0
  let conflicts = 0
  let release
  const bothSelected = new Promise(resolve => { release = resolve })
  for (const handle of [store, otherStore]) {
    const compareAndSwap = handle.compareAndSwap.bind(handle)
    let waiting = true
    handle.compareAndSwap = async (expectedRevision, nextState) => {
      if (waiting && expectedRevision === initialRevision) {
        waiting = false
        if (++arrivals === 2) release()
        await bothSelected
      }
      const replaced = await compareAndSwap(expectedRevision, nextState)
      if (!replaced) conflicts++
      return replaced
    }
  }

  await Promise.all([
    first.sendTransaction({ to: recipient, value: 12000n, feeRate: 1 }),
    second.sendTransaction({ to: recipient, value: 12000n, feeRate: 1 })
  ])

  assert.equal(arrivals, 2)
  assert.ok(conflicts >= 1, 'one writer must retry the stale revision')
  assert.equal(client.broadcasts.length, 2)
  const transactions = client.broadcasts.map(hex => client.inspectTransaction(hex))
  const outpoints = transactions.flatMap(tx => tx.inputs.map(input => `${input.txid}:${input.vout}`))
  assert.equal(new Set(outpoints).size, outpoints.length)
  const changes = transactions.flatMap(tx => tx.outputs.filter(output => output.address !== recipient))
  assert.deepEqual(changes.map(output => output.address).sort(), [addressAt(seed, "0'/1/0"), addressAt(seed, "0'/1/1")].sort())
})

test('async-only non-key-exporting signer supports HD derivation and multi-key spending', async (t) => {
  const seed = randomBytes(64)
  t.after(() => seed.fill(0))
  const signer = asynchronousRoot(seed)
  t.after(() => signer.dispose())
  const client = new InMemoryBitcoinClient()
  const wallet = new WalletManagerBtc(signer, { network: 'regtest', bip: 84, client })
  t.after(() => wallet.dispose())
  const hd = await wallet.getHdAccount(0, { gapLimit: 3, maxAddresses: 50, stateStore: await createStore(t) })
  client.fund(addressAt(seed, "0'/0/0"), 30000n)
  client.fund(addressAt(seed, "0'/1/0"), 30000n)

  await hd.sendTransaction({ to: randomAddress(), value: 50000n, feeRate: 1 })
  assert.equal(client.inspectTransaction(client.broadcasts[0]).inputs.length, 2)
  assert.ok(signer.observations.signatures >= 2)
  wallet.dispose()
  const stillUsable = await signer.derive("0'/0/9")
  assert.equal(await stillUsable.getAddress(), addressAt(seed, "0'/0/9"))
  stillUsable.dispose()
})

test('the default gap limit recovers activity at the twentieth address on either branch', async t => {
  const { wallet, client, seed, store } = await createWallet(t)
  client.fund(addressAt(seed, "0'/0/19"), 25000n)
  client.fund(addressAt(seed, "0'/1/19"), 35000n)
  const hd = await wallet.getHdAccount(0, { stateStore: store })
  assert.equal(await hd.getBalance(), 60000n)
})
