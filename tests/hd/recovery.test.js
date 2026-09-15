// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { addressAt, createStore, createWallet, randomAddress } from './helpers.js'

// Model the canonical RPC view after an unrelated allocation-anchor payment is
// orphaned, while another independent payment survives/reconfirms. This changes
// only the public client boundary; it is not a Bitcoin consensus/reorg emulator.
function canonicalViewWithout (chain, removed) {
  const view = {}
  for (const method of ['connect', 'close', 'reconnect', 'estimateFee', 'getBlockHeight', 'broadcast']) {
    view[method] = (...args) => chain[method](...args)
  }
  view.getHistory = async address => (await chain.getHistory(address)).filter(item => !removed.has(item.tx_hash))
  view.listUnspent = async address => (await chain.listUnspent(address)).filter(item => !removed.has(item.tx_hash))
  view.getBalance = async address => {
    const unspent = await view.listUnspent(address)
    return {
      confirmed: unspent.filter(item => item.height > 0).reduce((sum, item) => sum + item.value, 0),
      unconfirmed: unspent.filter(item => item.height <= 0).reduce((sum, item) => sum + item.value, 0)
    }
  }
  view.getTransaction = async hash => {
    if (removed.has(hash)) throw new Error('Transaction is absent from the canonical chain and mempool')
    return chain.getTransaction(hash)
  }
  return view
}

async function restore (t, seed, client, options, config = {}) {
  const wallet = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client, ...config })
  t.after(() => wallet.dispose())
  return wallet.getHdAccount(0, options)
}

async function storeFromSnapshot (t, snapshot) {
  const store = await createStore(t)
  assert.equal(await store.compareAndSwap(null, snapshot), true)
  return store
}

async function removedAnchorScenario (t) {
  const fixture = await createWallet(t)
  const { wallet, client, seed, store, hdOptions } = fixture
  const account = await wallet.getHdAccount(0, hdOptions)
  assert.equal(await account.getNewAddress(), addressAt(seed, "0'/0/1"))
  const anchorAddress = await account.getNewAddress()
  assert.equal(anchorAddress, addressAt(seed, "0'/0/2"))
  const staleSnapshot = await store.load()
  const anchor = client.fund(anchorAddress, 10000n)
  for (const index of [3, 4, 5]) assert.equal(await account.getNewAddress(), addressAt(seed, `0'/0/${index}`))
  const survivingAddress = addressAt(seed, "0'/0/5")
  const surviving = client.fund(survivingAddress, 50000n)
  const latestSnapshot = await store.load()
  assert.equal(await account.getBalance(), 60000n)
  wallet.dispose()
  const canonical = canonicalViewWithout(client, new Set([anchor]))
  assert.deepEqual(await canonical.getHistory(anchorAddress), [])
  assert.deepEqual(await canonical.listUnspent(anchorAddress), [])
  assert.equal((await canonical.getHistory(survivingAddress))[0].tx_hash, surviving)
  return { ...fixture, canonical, staleSnapshot, latestSnapshot, surviving }
}

test('the latest saved allocation state recovers a surviving payment after its earlier anchor disappears', async t => {
  const { seed, canonical, hdOptions, latestSnapshot, surviving } = await removedAnchorScenario(t)
  const restored = await restore(t, seed, canonical, { ...hdOptions, stateStore: await storeFromSnapshot(t, latestSnapshot) })
  assert.equal(await restored.getBalance(), 50000n)
  assert.equal((await restored.getTransaction(surviving)).finality, 'confirmed')
  assert.equal(await restored.getNewAddress(), addressAt(seed, "0'/0/6"))
})

test('a stale backup can miss later allocations even when a newer complete backup recovers them', async t => {
  const { seed, canonical, hdOptions, staleSnapshot, latestSnapshot } = await removedAnchorScenario(t)
  const stale = await restore(t, seed, canonical, { ...hdOptions, stateStore: await storeFromSnapshot(t, staleSnapshot) })
  const latest = await restore(t, seed, canonical, { ...hdOptions, stateStore: await storeFromSnapshot(t, latestSnapshot) })
  assert.equal(await stale.getBalance(), 0n)
  assert.equal(await latest.getBalance(), 50000n)
})

test('an explicit larger gap recovers the missing payment but a small seed-only scan cannot prove completeness', async t => {
  const { seed, canonical, hdOptions, surviving } = await removedAnchorScenario(t)
  const emptyStore = await createStore(t)
  const ordinary = await restore(t, seed, canonical, { ...hdOptions, stateStore: emptyStore })
  assert.equal(await ordinary.getBalance(), 0n)
  const expanded = await restore(t, seed, canonical, { ...hdOptions, gapLimit: 6, maxAddresses: 20, stateStore: emptyStore })
  assert.equal(await expanded.getBalance(), 50000n)
  assert.equal((await expanded.getTransfers({ limit: 1 }))[0].txid, surviving)
  assert.equal(await emptyStore.load(), null, 'a read must not fabricate lost allocation/reservation metadata')
  // Enlarging a read does not persist coverage. Returning to the original scan
  // policy without recovered metadata therefore still misses this payment.
  const originalPolicy = await restore(t, seed, canonical, { ...hdOptions, stateStore: emptyStore })
  assert.equal(await originalPolicy.getBalance(), 0n)
  const insufficientBudget = await restore(t, seed, canonical, {
    ...hdOptions, gapLimit: 6, maxAddresses: 8, stateStore: await createStore(t)
  })
  await assert.rejects(insufficientBudget.getBalance(), /maxAddresses/)
})

test('saved recovery state rejects a different seed, network, BIP or account root', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  await account.getNewAddress()
  const snapshot = await store.load()
  const otherSeed = randomBytes(64)
  t.after(() => otherSeed.fill(0))
  for (const [candidateSeed, config] of [[otherSeed, {}], [seed, { network: 'testnet' }], [seed, { bip: 44 }]]) {
    await assert.rejects(restore(t, candidateSeed, client, {
      ...hdOptions, stateStore: await storeFromSnapshot(t, snapshot)
    }, config), /mismatched account/)
  }
  const otherRoot = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client })
  t.after(() => otherRoot.dispose())
  await assert.rejects(otherRoot.getHdAccount(1, { ...hdOptions, stateStore: await storeFromSnapshot(t, snapshot) }), /mismatched account/)
})

test('a reduced scan budget cannot silently truncate persisted issued addresses', async t => {
  const { seed, canonical, hdOptions, latestSnapshot } = await removedAnchorScenario(t)
  await assert.rejects(restore(t, seed, canonical, {
    ...hdOptions, maxAddresses: 5, stateStore: await storeFromSnapshot(t, latestSnapshot)
  }), /reservation state/)
})

test('the seed and chain cannot reconstruct an unbroadcast signed transaction reservation', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const original = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const previousHex = await original.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  const previous = client.inspectTransaction(previousHex)
  const reservations = await original.getReservations()
  const snapshot = await store.load()
  assert.equal(await original.getBalance(), 0n)
  wallet.dispose()
  const saved = await restore(t, seed, client, { ...hdOptions, stateStore: await storeFromSnapshot(t, snapshot) })
  assert.deepEqual(await saved.getReservations(), reservations)
  assert.equal(await saved.getBalance(), 0n)
  const seedOnly = await restore(t, seed, client, { ...hdOptions, stateStore: await createStore(t) })
  assert.deepEqual(await seedOnly.getReservations(), [])
  assert.equal(await seedOnly.getBalance(), 100000n)
  // This deliberately demonstrates the hazard of resuming writes after metadata
  // loss. Both signatures are valid, but they conflict on the same outpoint.
  const conflictHex = await seedOnly.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  const conflict = client.inspectTransaction(conflictHex)
  assert.notEqual(previous.txid, conflict.txid)
  assert.deepEqual(previous.inputs, conflict.inputs)
  await client.broadcast(previousHex)
  await assert.rejects(seedOnly.sendTransaction(conflictHex), /Input already spent/)
  assert.equal(client.broadcasts.length, 1)
})
