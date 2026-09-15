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

import { addressAt, createWallet, randomAddress } from './helpers.js'

test('pending incoming and internal change are excluded consistently until confirmation', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  client.fund(addressAt(seed, "0'/0/1"), 20000n, { confirmed: false })
  // Deliberately unusable per-address balances model a provider's incompatible
  // pending trust policy. The HD contract uses confirmed UTXOs instead.
  client.getBalance = async () => { throw new Error('leaf balance must not determine HD spendable balance') }
  assert.equal(await hd.getBalance(), 100000n)
  const spend = await hd.sendTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  assert.equal(await hd.getBalance(), 0n)
  assert.equal((await hd.getMaxSpendable({ feeRate: 1 })).amount, 0n)
  client.mine()
  assert.equal(await hd.getBalance(), 110000n - spend.fee)
})

test('transaction lookup includes change-only histories with case-insensitive normalized receipts', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  const hash = client.fund(addressAt(seed, "0'/1/1"), 30000n, { confirmed: false })
  const pending = await hd.getTransaction(hash.toUpperCase())
  assert.equal(pending.hash, hash)
  assert.equal(pending.finality, 'pending')
  assert.equal(pending.confirmations, 0)
  assert.equal(await hd.getTransactionReceipt(hash), null)
  const height = client.mine()
  const confirmed = await hd.getTransaction(hash)
  assert.equal(confirmed.finality, 'confirmed')
  assert.equal(confirmed.block, height)
  assert.equal(confirmed.confirmations, 1)
  assert.equal(confirmed.success, true)
  assert.equal((await hd.getTransactionReceipt(hash)).getId(), hash)
  await assert.rejects(hd.getTransaction('0'.repeat(64)), error => error.name === 'NoSuchElementError')
})
