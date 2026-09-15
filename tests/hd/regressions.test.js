// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import test from 'node:test'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { addressAt, createWallet, JsonFileStateStore, randomAddress } from './helpers.js'

function disconnectedSession (chain) {
  let connected = false
  const calls = []
  const session = {
    calls,
    async connect () { calls.push('connect'); connected = true },
    async close () { connected = false },
    async reconnect () { connected = true }
  }
  for (const method of ['getBalance', 'getHistory', 'listUnspent', 'getTransaction', 'getBlockHeight', 'estimateFee', 'broadcast']) {
    session[method] = async (...args) => {
      calls.push(method)
      assert.equal(connected, true, `${method} requires this new client's connection`)
      return chain[method](...args)
    }
  }
  return session
}

test('restored signed transaction connects a fresh client before reading previous outputs and broadcasting', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const hex = await account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  const expected = client.inspectTransaction(hex)
  wallet.dispose()
  const session = disconnectedSession(client)
  const restoredWallet = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client: session })
  t.after(() => restoredWallet.dispose())
  const restored = await restoredWallet.getHdAccount(0, { ...hdOptions, stateStore: new JsonFileStateStore(store.path) })
  const result = await restored.sendTransaction(hex)
  assert.deepEqual(result, { hash: expected.txid, fee: expected.fee })
  assert.equal(session.calls[0], 'connect')
  assert.ok(session.calls.includes('getTransaction'))
  assert.ok(session.calls.includes('broadcast'))
  assert.deepEqual(client.broadcasts, [hex])
})

test('a one-row transfer page hydrates only its required transaction from a twenty-transaction history', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  const own = addressAt(seed, "0'/0/0")
  const deposits = []
  for (let index = 0; index < 20; index++) {
    const value = BigInt(10000 + index)
    deposits.push({ hash: client.fund(own, value), value })
    client.mine()
  }
  client.calls.length = 0
  const rows = await account.getTransfers({ limit: 1 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].txid, deposits.at(-1).hash)
  assert.equal(rows[0].value, deposits.at(-1).value)
  assert.deepEqual(client.calls.filter(call => call.method === 'getTransaction').map(call => call.txid), [deposits.at(-1).hash])
  client.calls.length = 0
  const skipped = await account.getTransfers({ skip: 1, limit: 1 })
  assert.equal(skipped[0].txid, deposits.at(-2).hash)
  assert.equal(client.calls.filter(call => call.method === 'getTransaction').length, 2)
})
