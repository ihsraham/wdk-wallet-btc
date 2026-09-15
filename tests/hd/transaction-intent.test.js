// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWallet, randomAddress } from './helpers.js'

for (const bip of [44, 84]) {
  for (const method of ['signTransaction', 'sendTransaction']) {
    for (const timing of ['queued', 'after reservation']) {
      test(`BIP${bip} ${method} preserves submitted fields when the caller edits them ${timing}`, { timeout: 5000 }, async t => {
        const { wallet, client, store, hdOptions } = await createWallet(t, { config: { bip } })
        const account = await wallet.getHdAccount(0, hdOptions)
        client.fund(await account.getAddress(), 100000n)
        const original = { to: randomAddress(), value: 10000n, feeRate: 1, confirmationTarget: 1 }
        const quote = await account.quoteSendTransaction(original)
        const transaction = { ...original }
        let reached, resume
        const reserved = new Promise(resolve => { reached = resolve })
        const continued = new Promise(resolve => { resume = resolve })
        t.after(() => resume())
        if (timing === 'after reservation') {
          const compareAndSwap = store.compareAndSwap.bind(store)
          let paused = false
          store.compareAndSwap = async (revision, next) => {
            const success = await compareAndSwap(revision, next)
            if (success && !paused) { paused = true; reached(); await continued }
            return success
          }
        }
        const pending = account[method](transaction)
        if (timing === 'after reservation') await reserved
        Object.assign(transaction, { to: randomAddress(), value: 1000n, feeRate: 50, confirmationTarget: 6 })
        resume()
        const result = await pending
        const hex = method === 'signTransaction' ? result : client.broadcasts[0]
        const inspected = client.inspectTransaction(hex)
        assert.equal(inspected.outputs[0].address, original.to)
        assert.equal(inspected.outputs[0].value, original.value)
        assert.equal(inspected.fee, quote.fee)
        assert.equal(client.broadcasts.length, method === 'signTransaction' ? 0 : 1)
      })
    }
  }
}

test('quote and maximum spend retain fee inputs while connecting', async t => {
  const { wallet, client, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  client.fund(await account.getAddress(), 100000n)
  const original = { to: randomAddress(), value: 10000n, feeRate: 1 }
  const quote = await account.quoteSendTransaction(original)
  const maximum = await account.getMaxSpendable({ feeRate: 1 })
  const transaction = { ...original }
  const options = { feeRate: 1 }
  const pendingQuote = account.quoteSendTransaction(transaction)
  const pendingMaximum = account.getMaxSpendable(options)
  Object.assign(transaction, { value: 50000n, feeRate: 50 })
  options.feeRate = 50
  assert.deepEqual(await pendingQuote, quote)
  assert.deepEqual(await pendingMaximum, maximum)
})
