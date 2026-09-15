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
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { networks, payments, Transaction } from 'bitcoinjs-lib'
import WalletManagerBtc, { WalletAccountHdBtc } from '@tetherto/wdk-wallet-btc'
import { InMemoryBitcoinClient } from '../hd/bitcoin-client.js'

function assertDeep (actual, expected) {
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    assert.strictEqual(actual, expected)
    return
  }
  assert.strictEqual(Array.isArray(actual), Array.isArray(expected))
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  assert.strictEqual(JSON.stringify(actualKeys), JSON.stringify(expectedKeys))
  for (const key of actualKeys) assertDeep(actual[key], expected[key])
}

async function assertRejects (operation, pattern) {
  let failure
  try { await operation } catch (error) { failure = error }
  assert.ok(failure instanceof Error, 'Expected an Error rejection')
  assert.ok(pattern.test(failure.message), 'Unexpected rejection reason: ' + failure.message)
}

const bip32 = BIP32Factory(ecc)
function expectedAddress (seed, bip, suffix) {
  const root = bip32.fromSeed(seed, networks.regtest)
  let leaf
  try {
    leaf = root.derivePath(`m/${bip}'/1'/${suffix}`)
    return (bip === 84 ? payments.p2wpkh : payments.p2pkh)({ pubkey: leaf.publicKey, network: networks.regtest }).address
  } finally {
    leaf?.privateKey.fill(0)
    leaf?.chainCode.fill(0)
    root.privateKey.fill(0)
    root.chainCode.fill(0)
  }
}

// A single-writer durable fixture. This gate does not test cross-process CAS or
// crash/fsync guarantees, which require a production storage adapter.
class StateStore {
  constructor (path) { this.path = path }
  async load () {
    try { return JSON.parse(await readFile(this.path, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async compareAndSwap (expected, next) {
    const state = await this.load()
    if ((state?.revision ?? null) !== expected) return false
    await writeFile(this.path + '.pending', JSON.stringify(next), { mode: 0o600 })
    await rename(this.path + '.pending', this.path)
    return true
  }
}

assert.ok(/^\d+\.\d+\.\d+$/.test(process.versions.node), 'Expected the official runtime compatibility target')
assert.ok(process.versions.bare, 'This gate must run under Bare, not Node')
const directory = await mkdtemp(join(tmpdir(), 'wdk-bare-hd-state-'))
const cases = []
try {
  for (const bip of [44, 84]) {
    const seed = randomBytes(64)
    const recipientSeed = randomBytes(64)
    let wallet, restoredWallet
    try {
      const client = new InMemoryBitcoinClient()
      const config = { bip, network: 'regtest', client }
      const stateStore = new StateStore(join(directory, `state-${bip}.json`))
      const options = { stateStore, gapLimit: 3, maxAddresses: 50 }
      wallet = new WalletManagerBtc(seed, config)
      const hd = await wallet.getHdAccount(0, options)
      assert.ok(hd instanceof WalletAccountHdBtc)
      const receiving = expectedAddress(seed, bip, "0'/0/0")
      const internal = expectedAddress(seed, bip, "0'/1/0")
      const recipient = expectedAddress(recipientSeed, bip, "0'/0/0")
      assert.strictEqual(await hd.getAddress(), receiving)
      assert.strictEqual(await hd.getNewAddress(), expectedAddress(seed, bip, "0'/0/1"))
      assert.ok((await stateStore.load()).revision >= 0)
      client.fund(receiving, 100000n)
      client.fund(internal, 50000n)
      assert.strictEqual(await hd.getBalance(), 150000n)
      const first = await hd.sendTransaction({ to: recipient, value: 110000n, feeRate: 2 })
      const firstTx = client.inspectTransaction(client.broadcasts[0])
      assert.strictEqual(firstTx.txid, first.hash)
      assertDeep(firstTx.inputs.map(input => input.address).sort(), [receiving, internal].sort())
      assertDeep(firstTx.outputs, [
        { index: 0, address: recipient, value: 110000n },
        { index: 1, address: expectedAddress(seed, bip, "0'/1/1"), value: 40000n - first.fee }
      ])
      assert.strictEqual(first.fee, firstTx.inputValue - firstTx.outputValue)
      assert.ok(first.fee >= BigInt(Transaction.fromHex(client.broadcasts[0]).virtualSize() * 2))
      client.mine()
      assert.strictEqual(await hd.getBalance(), 40000n - first.fee)
      wallet.dispose()
      wallet = null

      restoredWallet = new WalletManagerBtc(seed, config)
      const restored = await restoredWallet.getHdAccount(0, {
        ...options, stateStore: new StateStore(join(directory, `restored-${bip}.json`))
      })
      assert.strictEqual(await restored.getBalance(), 40000n - first.fee)
      const signed = await restored.signTransaction({ to: recipient, value: 10000n, feeRate: 2 })
      const tampered = Transaction.fromHex(signed)
      tampered.outs[0].value -= 1n
      await assertRejects(client.broadcast(tampered.toHex()), /Invalid input signature/)
      const second = await restored.sendTransaction(signed)
      const secondTx = client.inspectTransaction(signed)
      assert.strictEqual(second.fee, secondTx.fee)
      assertDeep(secondTx.inputs.map(input => input.address), [expectedAddress(seed, bip, "0'/1/1")])
      assertDeep(secondTx.outputs, [
        { index: 0, address: recipient, value: 10000n },
        { index: 1, address: expectedAddress(seed, bip, "0'/1/2"), value: 30000n - first.fee - second.fee }
      ])
      client.mine()
      assert.strictEqual(await restored.getBalance(), 30000n - first.fee - second.fee)
      const receipt = await restored.getTransaction(second.hash)
      assert.strictEqual(receipt.finality, 'confirmed')
      assert.strictEqual(receipt.confirmations, 1)
      const outgoing = await restored.getTransfers({ direction: 'outgoing', limit: 100 })
      assertDeep(outgoing.map(row => [row.txid, row.value]).sort(), [[first.hash, 110000n], [second.hash, 10000n]].sort())
      cases.push({ bip, acceptedSyntheticSpends: 2, multiKeyInputs: firstTx.inputs.length, firstFeeSats: Number(first.fee), secondFeeSats: Number(second.fee), tamperedSignatureRejected: true, seedOnlyRecovery: true })
    } finally {
      try { wallet?.dispose() } finally {
        try { restoredWallet?.dispose() } finally { seed.fill(0); recipientSeed.fill(0) }
      }
    }
  }
  const result = { checkedAt: new Date().toISOString(), bareVersion: process.versions.bare, nodeCompatibilityTarget: process.versions.node, syntheticOnly: true, cases }
  if (process.env.WDK_BARE_RESULT) await writeFile(process.env.WDK_BARE_RESULT, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}
