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
import WalletManagerBtc, { WalletAccountHdBtc } from '@tetherto/wdk-wallet-btc'
// Public test seed, only offline derivation. Never fund these addresses.
const seed = new Uint8Array(64).fill(7)
const client = { async connect () {}, async close () {}, async getHistory () { return [] }, async listUnspent () { return [] } }
let saved = null
const stateStore = { async load () { return saved }, async compareAndSwap (revision, next) { if ((saved?.revision ?? null) !== revision) return false; saved = JSON.parse(JSON.stringify(next)); return true } }
const manager = new WalletManagerBtc(seed, { client, network: 'regtest' })
const account = await manager.getHdAccount(0, { stateStore, gapLimit: 3, maxAddresses: 10 })
if (!(account instanceof WalletAccountHdBtc)) throw new Error('Missing HD export')
if (await account.getBalance() !== 0n) throw new Error('Incorrect empty balance')
if (await account.getAddress() === await account.getNewAddress()) throw new Error('Receiving address not rotated')
manager.dispose()
seed.fill(0)
console.log('packed HD runtime passed')
