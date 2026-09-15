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

import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { networks, payments } from 'bitcoinjs-lib'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import SeedSignerBtc from '../../src/signers/seed-signer-btc.js'
import { InMemoryBitcoinClient } from './bitcoin-client.js'

const bip32 = BIP32Factory(ecc)
const storeQueues = new Map()

// Independent store handles for the same file share an atomic CAS boundary in this
// process. Rename makes a completed write visible in full. This is a test adapter,
// not a claim of cross-process locking or crash/fsync guarantees.
export class JsonFileStateStore {
  constructor (path) {
    this.path = path
    this.writes = []
    this.failNextWrite = null
  }

  async load () {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async compareAndSwap (expectedRevision, nextState) {
    const previous = storeQueues.get(this.path) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const current = await this.load()
      if ((current?.revision ?? null) !== expectedRevision) return false
      if (this.failNextWrite) {
        const error = this.failNextWrite
        this.failNextWrite = null
        throw error
      }
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}`
      await writeFile(temporary, JSON.stringify(nextState), { mode: 0o600 })
      await rename(temporary, this.path)
      this.writes.push(structuredClone(nextState))
      return true
    })
    const settled = operation.catch(() => {})
    storeQueues.set(this.path, settled)
    try {
      return await operation
    } finally {
      if (storeQueues.get(this.path) === settled) storeQueues.delete(this.path)
    }
  }
}

export async function createStore (t) {
  const directory = await mkdtemp(join(tmpdir(), 'wdk-btc-hd-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return new JsonFileStateStore(join(directory, 'state.json'))
}

export async function createWallet (t, { seed = randomBytes(64), client = new InMemoryBitcoinClient(), config = {}, stateStore, options = {} } = {}) {
  t.after(() => seed.fill(0))
  const wallet = new WalletManagerBtc(seed, { network: 'regtest', bip: 84, client, ...config })
  t.after(() => wallet.dispose())
  const store = stateStore ?? await createStore(t)
  const hdOptions = { gapLimit: 3, maxAddresses: 50, stateStore: store, ...options }
  return { wallet, client, seed, store, hdOptions }
}

// Derive expected addresses independently of the account or signer being tested.
export function addressAt (seed, suffix) {
  const root = bip32.fromSeed(seed, networks.regtest)
  const node = root.derivePath(`m/84'/1'/${suffix}`)
  const { address } = payments.p2wpkh({ pubkey: node.publicKey, network: networks.regtest })
  node.privateKey.fill(0)
  node.chainCode.fill(0)
  root.privateKey.fill(0)
  root.chainCode.fill(0)
  return address
}

export function randomAddress () {
  const seed = randomBytes(64)
  try {
    return addressAt(seed, "0'/0/0")
  } finally {
    seed.fill(0)
  }
}

// This adapter deliberately exposes no synchronous address or private key. It
// delegates actual signing and derivation, so tests exercise asynchronous public
// signer capabilities rather than stubbing account implementation methods.
export class AsyncSigner {
  constructor (delegate, observations = { children: [], signatures: 0, disposals: 0 }) {
    this.delegate = delegate
    this.observations = observations
  }

  get isDerivable () { return this.delegate.isDerivable }
  get path () { return this.delegate.path }
  get network () { return this.delegate.network }
  get bip () { return this.delegate.bip }
  get address () { return undefined }
  get keyPair () { return null }

  async derive (path) {
    await setImmediate()
    const child = new AsyncSigner(await this.delegate.derive(path), this.observations)
    this.observations.children.push(child)
    return child
  }

  async getAddress () {
    await setImmediate()
    return this.delegate.getAddress()
  }

  async signPsbt (psbt) {
    await setImmediate()
    this.observations.signatures++
    return this.delegate.signPsbt(psbt)
  }

  async sign (message) {
    await setImmediate()
    return this.delegate.sign(message)
  }

  dispose () {
    this.observations.disposals++
    this.delegate.dispose()
  }
}

export function asynchronousRoot (seed) {
  return new AsyncSigner(new SeedSignerBtc(seed, "m/84'/1'", { network: 'regtest', bip: 84 }))
}
