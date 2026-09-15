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
import { TransactionError, TransactionErrorReason } from '@tetherto/wdk-wallet'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { InMemoryBitcoinClient } from './bitcoin-client.js'
import { createWallet, JsonFileStateStore, randomAddress } from './helpers.js'

for (const bip of [44, 84]) {
  test(`BIP${bip}: confirmed reservations survive a reorg and restart with current metadata`, async t => {
    const { wallet, client, seed, store, hdOptions } = await createWallet(t, { config: { bip } })
    const account = await wallet.getHdAccount(0, hdOptions)
    const receiving = await account.getAddress()
    const funding = client.fund(receiving, 100000n)
    const signed = await account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
    const first = client.inspectTransaction(signed)
    assert.deepEqual(first.inputs.map(input => `${input.txid}:${input.vout}`), [`${funding}:0`])
    await account.sendTransaction(signed)
    client.mine()
    assert.equal((await account.getTransaction(first.txid)).confirmations, 1)

    // Preparing a later spend must not forget the earlier signed reservation.
    const later = await account.signTransaction({ to: randomAddress(), value: 10000n, feeRate: 1 })
    assert.deepEqual(client.inspectTransaction(later).inputs.map(input => `${input.txid}:${input.vout}`), [`${first.txid}:1`])
    wallet.dispose()

    // Model only the provider's new canonical view: the original funding survives,
    // while its previously confirmed spend and descendants are absent from both
    // chain and mempool. This is not a consensus/reorg emulator.
    const canonical = new InMemoryBitcoinClient()
    assert.equal(canonical.fund(receiving, 100000n), funding)
    assert.deepEqual(await canonical.getHistory(receiving), [{ tx_hash: funding, height: 100 }])
    assert.equal((await canonical.listUnspent(receiving))[0].value, 100000)
    assert.equal(canonical.inspectTransaction(signed).txid, first.txid)

    const restored = new WalletManagerBtc(seed, { network: 'regtest', bip, client: canonical })
    t.after(() => restored.dispose())
    const current = await restored.getHdAccount(0, { ...hdOptions, stateStore: new JsonFileStateStore(store.path) })
    await assert.rejects(current.signTransaction({ to: randomAddress(), value: 12000n, feeRate: 1 }),
      error => error instanceof TransactionError && error.reason === TransactionErrorReason.INSUFFICIENT_BALANCE)
    assert.equal(await current.getBalance(), 0n)
    assert.deepEqual((await current.getReservations()).find(item => item.txid === first.txid).outpoints, [`${funding}:0`])
    // Previously exposed bytes remain valid and can still consume the input.
    await canonical.broadcast(signed)
    assert.deepEqual(canonical.broadcasts, [signed])
  })
}
