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
'use strict'

import IBtcClient from './transports/btc-client.js'

/** @typedef {import('./transports/index.js').BtcUtxo} BtcUtxo */
/** @typedef {import('./transports/index.js').BtcHistoryItem} BtcHistoryItem */

/**
 * Adapts the existing account-wide read methods to a discovered HD address set.
 * Signing, reservation and discovery policy remain in the HD account.
 * @internal
 */
export default class HdAccountClient extends IBtcClient {
  /** @param {IBtcClient} client @param {() => Promise<{available: BtcUtxo[], history: BtcHistoryItem[]}>} discover */
  constructor (client, discover) {
    super()
    this._client = client
    this._discover = discover
  }

  async connect () { return this._client.connect() }
  async close () {} // The owning account closes only its internally created transport.
  async reconnect () { return this._client.reconnect() }
  async estimateFee (target) { return this._client.estimateFee(target) }
  async getTransaction (hash) { return this._client.getTransaction(hash) }
  async broadcast (hex) { return this._client.broadcast(hex) }
  async getBlockHeight () {
    return typeof this._client.getBlockHeight === 'function' ? this._client.getBlockHeight() : null
  }

  async listUnspent () {
    const snapshot = await this._discover()
    return snapshot.available
  }

  async getBalance () {
    const outputs = await this.listUnspent()
    const confirmed = outputs.reduce((sum, output) => sum + BigInt(output.value), 0n)
    return { confirmed: Number(confirmed), unconfirmed: 0, unconfirmedOutgoing: 0 }
  }

  async getHistory () {
    const snapshot = await this._discover()
    return snapshot.history
  }
}
