// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import SeedSignerBtc from '../../src/signers/seed-signer-btc.js'
import { InMemoryBitcoinClient } from './bitcoin-client.js'
import { AsyncSigner, createStore } from './helpers.js'

function deferred () {
  let resolve
  const promise = new Promise(_resolve => { resolve = _resolve })
  return { promise, resolve }
}

// Track ownership at the signer boundary, including children returned only after
// an asynchronous device/remote derivation finishes.
class ObservedSigner extends AsyncSigner {
  constructor (delegate, control) {
    super(delegate)
    this.control = control
    this.disposeCount = 0
    control.instances.push(this)
  }

  async derive (path) {
    const child = new ObservedSigner(await this.delegate.derive(path), this.control)
    await this.control.afterDerive?.({ parent: this, child, path })
    return child
  }

  dispose () {
    this.disposeCount++
    super.dispose()
  }
}

async function setup (t, afterDerive) {
  const seed = randomBytes(64)
  t.after(() => seed.fill(0))
  const control = { instances: [], afterDerive }
  const signer = new ObservedSigner(new SeedSignerBtc(seed, "m/84'/1'", { network: 'regtest', bip: 84 }), control)
  t.after(() => {
    // Also clear any child material if an ownership assertion fails.
    for (const instance of control.instances) if (instance.disposeCount === 0) instance.dispose()
  })
  const wallet = new WalletManagerBtc(signer, { network: 'regtest', bip: 84, client: new InMemoryBitcoinClient() })
  t.after(() => wallet.dispose())
  const options = { gapLimit: 3, maxAddresses: 50, stateStore: await createStore(t) }
  return { wallet, signer, control, options }
}

test('concurrent HD account requests coalesce before asynchronous root derivation finishes', async t => {
  const entered = deferred()
  const resume = deferred()
  const { wallet, control, options } = await setup(t, async ({ path }) => {
    if (path === "0'") { entered.resolve(); await resume.promise }
  })
  const first = wallet.getHdAccount(0, options)
  await entered.promise
  const second = wallet.getHdAccount(0, { ...options })
  const third = wallet.getHdAccountByPath("0'", options)
  resume.resolve()
  const accounts = await Promise.all([first, second, third])
  assert.equal(accounts[0], accounts[1])
  assert.equal(accounts[1], accounts[2])
  assert.equal(control.instances.filter(signer => signer.path === "m/84'/1'/0'").length, 1)
  assert.equal(control.instances.filter(signer => signer.path === "m/84'/1'/0'/0/0").length, 1)
})

for (const blockedPath of ["0'", '0/0']) {
  test(`disposing the manager during awaited ${blockedPath} derivation disposes returned owned signers`, async t => {
    const entered = deferred()
    const resume = deferred()
    const { wallet, signer, control, options } = await setup(t, async ({ path }) => {
      if (path === blockedPath) { entered.resolve(); await resume.promise }
    })
    const pending = wallet.getHdAccount(0, options)
    const rejected = assert.rejects(pending, /disposed/i)
    await entered.promise
    wallet.dispose()
    resume.resolve()
    await rejected
    assert.equal(signer.disposeCount, 0, 'the caller-owned default signer must remain borrowed')
    assert.ok(control.instances.length >= 2)
    for (const child of control.instances.filter(instance => instance !== signer)) assert.equal(child.disposeCount, 1)
  })
}

test('disposing an account during discovery disposes a child returned after the disposal', async t => {
  const entered = deferred()
  const resume = deferred()
  const { wallet, signer, control, options } = await setup(t, async ({ path }) => {
    if (path === '0/1') { entered.resolve(); await resume.promise }
  })
  const account = await wallet.getHdAccount(0, options)
  const pending = account.getBalance()
  const rejected = assert.rejects(pending, /disposed/i)
  await entered.promise
  account.dispose()
  resume.resolve()
  await rejected
  assert.equal(signer.disposeCount, 0)
  for (const child of control.instances.filter(instance => instance !== signer)) assert.equal(child.disposeCount, 1)
})

test('creation failure cleans the owned account root and leaf while preserving the borrowed default', async t => {
  const { wallet, signer, control, options } = await setup(t)
  const failingOptions = { ...options, stateStore: { load: async () => { throw new Error('simulated store read failure') }, compareAndSwap: async () => true } }
  await assert.rejects(wallet.getHdAccount(0, failingOptions), /store read failure/)
  assert.equal(signer.disposeCount, 0)
  assert.equal(control.instances.length, 3)
  for (const child of control.instances.filter(instance => instance !== signer)) assert.equal(child.disposeCount, 1)
  // A failed creation must also remove its cache entry, allowing a healthy retry.
  const account = await wallet.getHdAccount(0, options)
  assert.equal(typeof await account.getAddress(), 'string')
})

test('a throwing owned root disposal still disposes its leaf and the manager\'s other owned accounts', async t => {
  const { wallet, signer, control, options } = await setup(t)
  await wallet.getHdAccount(0, options)
  await wallet.getHdAccount(1, { ...options, stateStore: await createStore(t) })
  const root = control.instances.find(instance => instance.path === "m/84'/1'/0'")
  const dispose = root.dispose.bind(root)
  root.dispose = () => { dispose(); throw new Error('simulated owned root disposal failure') }
  assert.throws(() => wallet.dispose(), /owned root disposal failure/)
  assert.equal(signer.disposeCount, 0)
  assert.equal(control.instances.length, 5)
  for (const child of control.instances.filter(instance => instance !== signer)) assert.equal(child.disposeCount, 1)
})
