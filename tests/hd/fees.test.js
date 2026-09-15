// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import test from 'node:test'
import { Transaction } from 'bitcoinjs-lib'

import { addressAt, createWallet, randomAddress } from './helpers.js'

test('quote, maximum spend and execution consistently reject invalid explicit fee rates', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const to = randomAddress()
  for (const feeRate of [0, -1, NaN, Infinity, '2', true]) {
    const transaction = { to, value: 10000n, feeRate }
    await assert.rejects(account.quoteSendTransaction(transaction), `quote must reject ${String(feeRate)}`)
    await assert.rejects(account.getMaxSpendable({ feeRate }), `maximum must reject ${String(feeRate)}`)
    await assert.rejects(account.signTransaction(transaction), `signing must reject ${String(feeRate)}`)
  }
  assert.deepEqual(await account.getReservations(), [])
  assert.deepEqual(client.broadcasts, [])
})

test('fractional fee rate normalization agrees across quote, maximum spend and execution', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const to = randomAddress()
  const normalized = await account.quoteSendTransaction({ to, value: 10000n, feeRate: 2 })
  const fractional = await account.quoteSendTransaction({ to, value: 10000n, feeRate: 1.5 })
  assert.deepEqual(fractional, normalized)
  assert.deepEqual(await account.getMaxSpendable({ feeRate: 1.5 }), await account.getMaxSpendable({ feeRate: 2 }))
  const hex = await account.signTransaction({ to, value: 10000n, feeRate: 1.5 })
  const parsed = client.inspectTransaction(hex)
  assert.equal(parsed.outputs[0].value, 10000n)
  assert.equal(parsed.fee, fractional.fee)
  assert.ok(parsed.fee >= BigInt(Transaction.fromHex(hex).virtualSize()) * 2n)
})

test('a positive sub-one fee rate uses the same one satoshi minimum in every operation', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const to = randomAddress()
  assert.deepEqual(
    await account.quoteSendTransaction({ to, value: 10000n, feeRate: 0.1 }),
    await account.quoteSendTransaction({ to, value: 10000n, feeRate: 1 })
  )
  assert.deepEqual(await account.getMaxSpendable({ feeRate: 0.1 }), await account.getMaxSpendable({ feeRate: 1 }))
  const hex = await account.signTransaction({ to, value: 10000n, feeRate: 0.1 })
  const parsed = client.inspectTransaction(hex)
  assert.equal(parsed.outputs[0].value, 10000n)
  assert.ok(parsed.fee >= BigInt(Transaction.fromHex(hex).virtualSize()))
})

test('sending the maximum quote preserves the exact requested recipient amount and actual fee', async t => {
  for (const feeRate of [1, 2, 10]) {
    await t.test(`${feeRate} sat/vB`, async t => {
      const { wallet, client, seed, hdOptions } = await createWallet(t)
      const account = await wallet.getHdAccount(0, hdOptions)
      client.fund(addressAt(seed, "0'/0/0"), 40000n)
      client.fund(addressAt(seed, "0'/1/0"), 60000n)
      const maximum = await account.getMaxSpendable({ feeRate })
      const to = randomAddress()
      const result = await account.sendTransaction({ to, value: maximum.amount, feeRate })
      const hex = client.broadcasts[0]
      const parsed = client.inspectTransaction(hex)
      assert.equal(parsed.outputs.filter(output => output.address === to).reduce((sum, output) => sum + output.value, 0n), maximum.amount)
      assert.equal(result.fee, parsed.fee)
      assert.equal(parsed.inputValue - parsed.outputValue, result.fee)
      assert.ok(result.fee >= BigInt(Transaction.fromHex(hex).virtualSize()) * BigInt(feeRate))
    })
  }
})
