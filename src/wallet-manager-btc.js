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

import WalletManager, { InvalidSignerError, ValueError } from '@tetherto/wdk-wallet'

import FailoverProvider from '@tetherto/wdk-failover-provider'

import WalletAccountBtc from './wallet-account-btc.js'
import WalletAccountHdBtc from './wallet-account-hd-btc.js'
import { isIndex } from './hd-account-state.js'
import SeedSignerBtc, { getBtcDerivationPathPrefix } from './signers/seed-signer-btc.js'

/** @typedef {import('@tetherto/wdk-wallet').FeeRates} FeeRates */
/** @typedef {import('@tetherto/wdk-wallet').ISigner} ISigner */
/** @typedef {import('@tetherto/wdk-wallet').NoSuchElementError} NoSuchElementError */
/** @typedef {import('./wallet-account-hd-btc.js').HdAccountOptions} HdAccountOptions */

/** @typedef {import('./wallet-account-btc.js').BtcWalletConfig} BtcWalletConfig */

/** @typedef {import('./signers/signer-btc.js').ISignerBtc} ISignerBtc */
/** @typedef {import('./transports/index.js').IBtcClient} IBtcClient */

const MEMPOOL_SPACE_URL = 'https://mempool.space'

export default class WalletManagerBtc extends WalletManager {
  /**
   * Creates a new wallet manager for the bitcoin blockchain from a BIP-39 seed.
   *
   * @overload
   * @param {string | Uint8Array} seed - The BIP-39 seed phrase or raw seed bytes.
   * @param {BtcWalletConfig} [config] - The configuration object.
   * @throws {ValueError} If the seed phrase is invalid.
   */

  /**
   * Creates a new wallet manager for the bitcoin blockchain from a default signer.
   *
   * The default signer must be derivable (it must be able to derive child accounts);
   * non-derivable signers (e.g. private-key signers) are not allowed as the default but
   * may be registered by name via {@link addSigner}.
   * **Warning:** the signer is kept exactly as given, not cloned. Disposing it directly breaks
   * further account derivation, and the manager never disposes a signer you supplied.
   *
   * @overload
   * @param {ISigner} signer - The default signer.
   * @param {BtcWalletConfig} [config] - The configuration object.
   * @throws {InvalidSignerError} If the default signer does not support account derivation.
   */
  constructor (seedOrSigner, config = {}) {
    const isSeed = typeof seedOrSigner === 'string' || seedOrSigner instanceof Uint8Array
    let signer = seedOrSigner
    if (isSeed) {
      const { network, bip } = config
      signer = new SeedSignerBtc(seedOrSigner, `m/${getBtcDerivationPathPrefix({ network, bip })}`, { network, bip })
    }
    if (!signer.isDerivable) {
      throw new InvalidSignerError('The default signer must be derivable. Non-derivable signers (e.g. private-key signers) can only be registered by name via addSigner.')
    }
    super(signer, config)

    /**
     * If true, disposes the default signer on calls to the 'dispose' method.
     *
     * @protected
     * @type {boolean}
     */
    this._shouldWipeDefaultSignerOnDisposal = isSeed

    /** @private */
    this._hdAccounts = new Map()
    /** @private */
    this._hdDisposed = false

    const clientOptions = config.client ? [config.client].flat() : [{ type: 'electrum', clientConfig: { host: 'electrum.blockstream.info', port: 50_001 } }]

    /**
     * A list of all the bitcoin client options.
     *
     * @protected
     * @type {Array<IBtcClient>}
     */
    this._clientList = clientOptions.map(client => WalletAccountBtc._createClient(client, this._config.network))

    /**
     * A client to interact with the bitcoin network.
     *
     * @protected
     * @type {IBtcClient}
     */
    this._client = this._clientList[0]

    if (this._clientList.length > 1) {
      const failoverProvider = new FailoverProvider({ retries: this._config.retries })
      for (const entry of this._clientList) {
        failoverProvider.addProvider(entry)
      }
      this._client = failoverProvider.initialize()
    }
  }

  /**
   * Returns the wallet account at a specific index.
   *
   * **Warning:** derivation is relative to the signer's own path. If the signer sits at a leaf
   * (e.g. m/84'/0'/0'/0/0), getAccount(1) derives m/84'/0'/0'/0/0/0'/0/1 — probably not what
   * you want; use a signer at the purpose/coin-type root (e.g. m/84'/0').
   *
   * @overload
   * @param {number} [index] - The index of the account to get (default: 0).
   * @param {Object} [options] - Account options.
   * @param {string} [options.signerName] - The signer name. Omit to use the default signer.
   * @returns {Promise<WalletAccountBtc>} The account.
   * @throws {NoSuchElementError} If a signer name is given but no signer exists with that name.
   * @throws {InvalidSignerError} If the signer doesn't support account derivation.
   * @example
   * // Returns the account with derivation path
   * // For mainnet (bitcoin): m/84'/0'/0'/0/1
   * // For testnet or regtest: m/84'/1'/0'/0/1
   * const account = await wallet.getAccount(1);
   */

  /**
   * Returns the wallet account associated with a registered signer.
   *
   * **Warning:** the returned account wraps the registered signer itself, exactly where it
   * sits - e.g. a second seed registered at the intermediate path "m/84'/0'" yields the
   * account AT "m/84'/0'", not at a derived leaf, which is rarely what you want to transact
   * with. Disposing the returned account leaves the registered signer untouched.
   *
   * @overload
   * @param {string} signerName - The signer name registered via {@link addSigner}.
   * @returns {Promise<WalletAccountBtc>} The account.
   * @throws {NoSuchElementError} If no signer exists with the given name.
   */

  async getAccount (indexOrSignerName = 0, options = {}) {
    if (typeof indexOrSignerName === 'string') {
      const key = indexOrSignerName
      if (this._accounts[key]) {
        return this._accounts[key]
      }
      const signer = this.getSigner(indexOrSignerName)
      const account = new WalletAccountBtc(signer, { ...this._config, client: this._clientList })
      this._accounts[key] = account
      return account
    }

    const { signerName } = options
    return await this.getAccountByPath(`0'/0/${indexOrSignerName}`, { signerName })
  }

  /**
   * Returns the wallet account at a specific derivation path.
   *
   * @example
   * // Returns the account with derivation path:
   * // For mainnet (bitcoin): m/84'/0'/0'/0/1
   * // For testnet or regtest: m/84'/1'/0'/0/1
   * const account = await wallet.getAccountByPath("0'/0/1");
   * @param {string} path - The derivation path (e.g. "0'/0/0").
   * @param {Object} [options] - Account options.
   * @param {string} [options.signerName] - The signer name. Omit to use the default signer.
   * @returns {Promise<WalletAccountBtc>} The account.
   * @throws {NoSuchElementError} If a signer name is given but no signer exists with that name.
   * @throws {InvalidSignerError} If the signer doesn't support account derivation.
   */
  async getAccountByPath (path, options = {}) {
    const { signerName } = options
    const key = signerName ? `${signerName}:${path}` : path
    if (this._accounts[key]) {
      return this._accounts[key]
    }
    const signer = this.getSigner(signerName)
    const childSigner = await signer.derive(path)
    const account = new WalletAccountBtc(childSigner, { ...this._config, client: this._clientList, shouldWipeSignerOnDisposal: true })
    this._accounts[key] = account
    return account
  }

  /**
   * Returns a multi-address account rooted at accountIndex'. Derivation is relative
   * to the selected signer's path, normally the purpose/coin-type root.
   * Never spend through overlapping legacy accounts or independent state stores.
   * @param {number | undefined} accountIndex - Non-hardened account number (default 0).
   * @param {HdAccountOptions} options - Required dedicated durable reservation store and discovery limits.
   * @returns {Promise<WalletAccountHdBtc>}
   */
  async getHdAccount (accountIndex = 0, options) {
    if (!isIndex(accountIndex)) throw new ValueError('Invalid HD account index.')
    return this.getHdAccountByPath(`${accountIndex}'`, options)
  }

  /**
   * Returns an HD account at a relative root path. Use an empty path when a
   * registered signer already represents the desired account root.
   * Concurrent requests share one instance. Its store and discovery limits cannot change.
   * @param {string} path - Relative account root, for example "0'".
   * @param {HdAccountOptions} options - Required dedicated durable reservation store and discovery limits.
   * @returns {Promise<WalletAccountHdBtc>}
   */
  async getHdAccountByPath (path, options) {
    if (this._hdDisposed) throw new InvalidSignerError('The wallet manager has been disposed.')
    if (typeof path !== 'string' || (path !== '' && !/^(0|[1-9][0-9]*)'?(\/(0|[1-9][0-9]*)'?)*$/.test(path))) throw new ValueError('Invalid relative HD account path.')
    if (path.split('/').some(segment => segment && !isIndex(Number(segment.replace("'", ''))))) throw new ValueError('Invalid HD account path index.')
    if (!options?.stateStore) throw new ValueError('HD accounts require a durable state store.')
    const { signerName, stateStore, gapLimit = 20, maxAddresses = 1000 } = options
    const signer = this.getSigner(signerName)
    if (!signer.isDerivable) throw new InvalidSignerError('HD accounts require a derivable signer.')
    let accounts = this._hdAccounts.get(signer)
    if (!accounts) { accounts = new Map(); this._hdAccounts.set(signer, accounts) }
    const existing = accounts.get(path)
    if (existing) {
      if (existing.stateStore !== stateStore || existing.gapLimit !== gapLimit || existing.maxAddresses !== maxAddresses) throw new ValueError('The cached HD account has different storage or discovery options.')
      return existing.promise
    }
    const entry = { stateStore, gapLimit, maxAddresses, account: null, promise: null }
    accounts.set(path, entry)
    entry.promise = (async () => {
      let root
      try {
        root = path === '' ? signer : await signer.derive(path)
        if (path !== '' && root === signer) throw new InvalidSignerError('Derivation must return an independent child signer.')
        if (this._hdDisposed) {
          if (root !== signer) root.dispose()
          throw new InvalidSignerError('The wallet manager has been disposed.')
        }
        const account = await WalletAccountHdBtc.create(root, { ...this._config, client: this._clientList, stateStore, gapLimit, maxAddresses }, root !== signer)
        if (this._hdDisposed) { account.dispose(); throw new InvalidSignerError('The wallet manager has been disposed.') }
        entry.account = account
        return account
      } catch (error) {
        accounts.delete(path)
        throw error
      }
    })()
    return entry.promise
  }

  /**
   * Returns the current fee rates.
   *
   * @returns {Promise<FeeRates>} The fee rates (in satoshis).
   */
  async getFeeRates () {
    const response = await fetch(`${MEMPOOL_SPACE_URL}/api/v1/fees/recommended`)

    const { fastestFee, hourFee } = await response.json()

    return {
      normal: BigInt(hourFee),
      fast: BigInt(fastestFee)
    }
  }

  /**
   * A list that maps each client to a flag that is true only if the client was externally provided.
   *
   * @protected
   * @type {Array<boolean>}
   */
  get _isExternalClient () {
    if (!this._config.client) return [false]
    return [this._config.client].flat().map(client => typeof client.connect === 'function')
  }

  /**
   * Disposes all the wallet accounts, erasing their private keys from the memory and closing all internal connections.
   * The default signer is wiped only if the manager created it internally from a seed.
   */
  dispose () {
    this._hdDisposed = true
    const errors = []
    const dispose = action => {
      try { action() } catch (error) { errors.push(error) }
    }
    for (const accounts of this._hdAccounts.values()) {
      for (const entry of accounts.values()) dispose(() => entry.account?.dispose())
    }
    this._hdAccounts.clear()
    for (const [i, isExternal] of this._isExternalClient.entries()) {
      if (!isExternal) dispose(() => this._clientList[i].close())
    }
    if (this._shouldWipeDefaultSignerOnDisposal) dispose(() => this._defaultSigner.dispose())
    dispose(() => super.dispose())
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Multiple wallet resources failed disposal.')
  }
}
