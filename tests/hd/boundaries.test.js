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

import { validateState } from '../../src/hd-account-state.js'
import PrivateKeySignerBtc from '../../src/signers/private-key-signer-btc.js'
import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { addressAt, asynchronousRoot, createStore, createWallet, JsonFileStateStore, randomAddress } from './helpers.js'

test('HD account creation requires an atomic store and validates bounded account discovery options', async t => {
  const { wallet, hdOptions } = await createWallet(t)
  await assert.rejects(wallet.getHdAccount())
  await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, stateStore: { load: async () => null, save: async () => {} } }))
  for (const gapLimit of [0, -1, 1.5, NaN, Infinity, '3']) {
    await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, gapLimit }))
  }
  for (const maxAddresses of [0, -1, 1.5, NaN, Infinity, '50', 2]) {
    await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, maxAddresses }))
  }
  for (const index of [-1, 1.5, NaN, Infinity, 0x80000000]) {
    await assert.rejects(wallet.getHdAccount(index, hdOptions))
  }
  for (const path of [null, 0, '/', '0//0', '01', "m/84'/1'/0'", "-1'", "2147483648'"]) {
    await assert.rejects(wallet.getHdAccountByPath(path, hdOptions))
  }
})

test('cached HD accounts cannot silently retain different discovery or storage options', async t => {
  const { wallet, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  assert.equal(await wallet.getHdAccount(0, { ...hdOptions }), account)
  await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, gapLimit: 4 }))
  await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, maxAddresses: 60 }))
  await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, stateStore: await createStore(t) }))
})

test('named derivable signers preserve account semantics; named leaf signers are rejected', async t => {
  const { wallet, seed, hdOptions } = await createWallet(t)
  const namedSeed = randomBytes(64)
  const key = randomBytes(32)
  t.after(() => { namedSeed.fill(0); key.fill(0) })
  const signer = asynchronousRoot(namedSeed)
  const leaf = new PrivateKeySignerBtc(key, { network: 'regtest', bip: 84 })
  t.after(() => { signer.dispose(); leaf.dispose() })
  wallet.addSigner('named', signer)
  wallet.addSigner('leaf', leaf)
  const named = await wallet.getHdAccount(1, { ...hdOptions, signerName: 'named' })
  assert.equal(await named.getAddress(), addressAt(namedSeed, "1'/0/0"))
  assert.notEqual(await named.getAddress(), addressAt(seed, "1'/0/0"))
  await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, signerName: 'leaf' }))
  await assert.rejects(wallet.getHdAccount(0, { ...hdOptions, signerName: 'missing' }))
  wallet.dispose()
  assert.equal(typeof await leaf.sign('borrowed leaf remains available'), 'string')
  const stillUsable = await signer.derive("1'/0/9")
  assert.equal(await stillUsable.getAddress(), addressAt(namedSeed, "1'/0/9"))
  stillUsable.dispose()
})

test('HD read-only conversion explicitly rejects unsupported future-address discovery', async t => {
  const { wallet, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  await assert.rejects(async () => hd.toReadOnlyAccount(), error => error.name === 'UnsupportedOperationError')
})

test('an empty relative path borrows an already-derived account root without disposing it', async t => {
  const { wallet, seed, hdOptions } = await createWallet(t)
  const signer = asynchronousRoot(seed)
  t.after(() => signer.dispose())
  const accountRoot = await signer.derive("2'")
  t.after(() => accountRoot.dispose())
  wallet.addSigner('account-root', accountRoot)
  const hd = await wallet.getHdAccountByPath('', { ...hdOptions, signerName: 'account-root' })
  assert.equal(await hd.getAddress(), addressAt(seed, "2'/0/0"))
  hd.dispose()
  const child = await accountRoot.derive('0/3')
  try {
    assert.equal(await child.getAddress(), addressAt(seed, "2'/0/3"))
  } finally {
    child.dispose()
  }
})

test('discovery fails closed at its address bound instead of returning a partial balance', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t, { options: { gapLimit: 2, maxAddresses: 4 } })
  for (let index = 0; index < 4; index++) client.fund(addressAt(seed, `0'/0/${index}`), 10000n)
  const hd = await wallet.getHdAccount(0, hdOptions)
  await assert.rejects(hd.getBalance())
  await assert.rejects(hd.sendTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }))
  assert.deepEqual(client.broadcasts, [])
})

test('maximum execution fee applies to both signing and sending without consuming a reservation', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t, { config: { transactionMaxFee: 1n } })
  client.fund(addressAt(seed, "0'/0/0"), 100000n)
  const hd = await wallet.getHdAccount(0, hdOptions)
  const transaction = { to: randomAddress(), value: 10000n, feeRate: 2 }
  await assert.rejects(hd.signTransaction(transaction), error => error.name === 'MaximumFeeExceededError')
  await assert.rejects(hd.sendTransaction(transaction), error => error.name === 'MaximumFeeExceededError')
  assert.deepEqual(await hd.getReservations(), [])
  assert.deepEqual(client.broadcasts, [])
  assert.equal(await hd.getBalance(), 100000n)
})

test('malformed address history and UTXO responses do not become empty or partial balances', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  const own = addressAt(seed, "0'/0/0")
  client.fund(own, 100000n)
  const history = client.getHistory.bind(client)
  const unspent = client.listUnspent.bind(client)
  for (const invalid of [null, {}, [{ tx_hash: 'not-a-hash', height: 100 }], [{ tx_hash: 'a'.repeat(64), height: NaN }]]) {
    client.getHistory = async address => address === own ? invalid : history(address)
    await assert.rejects(hd.getBalance())
  }
  client.getHistory = history
  const [valid] = await unspent(own)
  for (const invalid of [null, {}, [{ ...valid, value: -1 }], [{ ...valid, value: Number.MAX_SAFE_INTEGER + 1 }], [{ ...valid, tx_pos: -1 }], [{ ...valid, height: undefined }]]) {
    client.listUnspent = async address => address === own ? invalid : unspent(address)
    await assert.rejects(hd.getBalance())
  }
  client.listUnspent = unspent
  assert.equal(await hd.getBalance(), 100000n)
  assert.deepEqual(client.broadcasts, [])
})

test('selected provider UTXO values must agree with the actual funding transaction before signing', async t => {
  const { wallet, client, seed, hdOptions } = await createWallet(t)
  const hd = await wallet.getHdAccount(0, hdOptions)
  const own = addressAt(seed, "0'/0/0")
  client.fund(own, 100000n)
  const listUnspent = client.listUnspent.bind(client)
  client.listUnspent = async address => (await listUnspent(address)).map(output => ({ ...output, value: output.value + 10000 }))
  await assert.rejects(hd.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 }))
  assert.deepEqual(client.broadcasts, [])
})

test('state from another HD account is rejected instead of silently resetting reservations', async t => {
  const first = await createWallet(t)
  const original = await first.wallet.getHdAccount(0, first.hdOptions)
  await original.getNewAddress()
  const other = await createWallet(t, { stateStore: new JsonFileStateStore(first.store.path) })
  await assert.rejects(other.wallet.getHdAccount(0, other.hdOptions))
  assert.equal(await original.getAddress(), addressAt(first.seed, "0'/0/0"))
})

test('malformed persisted state and non-boolean CAS acknowledgements fail closed', async t => {
  const { wallet, hdOptions } = await createWallet(t)
  for (const state of [undefined, {}, [], { version: 2 }]) {
    await assert.rejects(wallet.getHdAccount(0, {
      ...hdOptions,
      stateStore: { load: async () => state, compareAndSwap: async () => true }
    }))
  }
  const account = await wallet.getHdAccount(0, {
    ...hdOptions,
    stateStore: { load: async () => null, compareAndSwap: async () => undefined }
  })
  await assert.rejects(account.getNewAddress())
})

test('persisted reservations require canonical transaction IDs and uint32 output indexes', () => {
  const hash = 'a'.repeat(64)
  const state = {
    version: 1, revision: 0, accountId: 'test-account', nextReceiveIndex: 1, nextChangeIndex: 0,
    reservations: [{ id: 0, outpoints: [`${hash}:0`], txid: null, changeIndex: null }]
  }
  for (const txid of [null, hash]) {
    state.reservations[0].txid = txid
    assert.deepEqual(validateState(state, 'test-account', 50), state)
  }
  state.reservations[0].txid = hash.toUpperCase()
  assert.throws(() => validateState(state, 'test-account', 50), /Invalid HD account reservation/)
  state.reservations[0].txid = hash
  for (const index of ['0', '1', '4294967295']) {
    state.reservations[0].outpoints = [`${hash}:${index}`]
    assert.deepEqual(validateState(state, 'test-account', 50), state)
  }
  for (const indexes of [['00'], ['01'], ['4294967296'], ['0', '00']]) {
    state.reservations[0].outpoints = indexes.map(index => `${hash}:${index}`)
    assert.throws(() => validateState(state, 'test-account', 50), /Invalid or duplicate reserved Bitcoin input/)
  }
})

test('restoring a signed reservation rejects a leading-zero outpoint before opening the account', async t => {
  const { wallet, client, seed, store, hdOptions } = await createWallet(t)
  const account = await wallet.getHdAccount(0, hdOptions)
  const funding = client.fund(await account.getAddress(), 100000n)
  const signed = await account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
  const snapshot = await store.load()
  assert.equal(snapshot.reservations[0].txid, client.inspectTransaction(signed).txid)
  assert.deepEqual(snapshot.reservations[0].outpoints, [`${funding}:0`])
  assert.equal(await account.getBalance(), 0n)
  wallet.dispose()

  snapshot.reservations[0].outpoints = [`${funding}:00`]
  const damagedStore = await createStore(t)
  assert.equal(await damagedStore.compareAndSwap(null, snapshot), true)
  const restored = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client })
  t.after(() => restored.dispose())
  await assert.rejects(restored.getHdAccount(0, { ...hdOptions, stateStore: damagedStore }), /Invalid or duplicate reserved Bitcoin input/)
  assert.deepEqual(client.broadcasts, [])
})
