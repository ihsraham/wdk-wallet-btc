// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { networks, payments } from 'bitcoinjs-lib'

import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { JsonFileStateStore } from '../hd/helpers.js'
import { BitcoinCoreClient, startBitcoinCore } from './bitcoin-core-client.js'

if (!process.env.BITCOIND_PATH) throw new Error('Set BITCOIND_PATH to a verified Core binary')

const bip32 = BIP32Factory(ecc)
const sats = value => BigInt(Math.round(value * 100000000))
const bitcoin = value => Number(value) / 100000000

function expectedAddress (seed, bip, path) {
  const root = bip32.fromSeed(seed, networks.regtest)
  let leaf
  try {
    leaf = root.derivePath(`m/${bip}'/1'/${path}`)
    return (bip === 84 ? payments.p2wpkh : payments.p2pkh)({ pubkey: leaf.publicKey, network: networks.regtest }).address
  } finally {
    leaf?.privateKey.fill(0)
    leaf?.chainCode.fill(0)
    root.privateKey.fill(0)
    root.chainCode.fill(0)
  }
}

async function signedMinerTransaction (rpc, input, outputs) {
  const unsigned = await rpc('createrawtransaction', [[{ txid: input.txid, vout: input.vout }], outputs, 0, true])
  const signed = await rpc('signrawtransactionwithwallet', [unsigned], 'wdk-regtest-miner')
  assert.equal(signed.complete, true)
  return signed.hex
}

async function acceptAndBroadcast (rpc, hex) {
  const [acceptance] = await rpc('testmempoolaccept', [[hex]])
  assert.equal(acceptance.allowed, true, acceptance['reject-reason'])
  return rpc('sendrawtransaction', [hex])
}

const directory = await mkdtemp(join(tmpdir(), 'wdk-hd-recovery-state-'))
let node
const results = []
try {
  node = await startBitcoinCore(process.env.BITCOIND_PATH)
  const { rpc } = node
  const miningAddress = node.client.miningAddress
  // Multiple mature, independent inputs prevent the surviving deposit from
  // depending on the allocation-anchor transaction that the fork removes.
  await rpc('generatetoaddress', [20, miningAddress])
  for (const bip of [44, 84]) {
    const seed = randomBytes(64)
    const wallets = []
    try {
      const beforeFork = new BitcoinCoreClient(rpc, miningAddress)
      const originalStore = new JsonFileStateStore(join(directory, `original-${bip}.json`))
      const originalWallet = new WalletManagerBtc(seed, { network: 'regtest', bip, client: beforeFork })
      wallets.push(originalWallet)
      const options = { gapLimit: 3, maxAddresses: 50, stateStore: originalStore }
      const original = await originalWallet.getHdAccount(0, options)
      assert.equal(await original.getNewAddress(), expectedAddress(seed, bip, "0'/0/1"))
      const anchorAddress = await original.getNewAddress()
      assert.equal(anchorAddress, expectedAddress(seed, bip, "0'/0/2"))
      const eligible = await rpc('listunspent', [101], 'wdk-regtest-miner')
      const inputs = eligible.filter(output => output.spendable && sats(output.amount) > 1000000n).slice(0, 2)
      assert.equal(inputs.length, 2)
      assert.notEqual(`${inputs[0].txid}:${inputs[0].vout}`, `${inputs[1].txid}:${inputs[1].vout}`)
      const anchorHex = await signedMinerTransaction(rpc, inputs[0], {
        [anchorAddress]: bitcoin(10000n),
        [miningAddress]: bitcoin(sats(inputs[0].amount) - 10000n - 1000n)
      })
      const anchor = await acceptAndBroadcast(rpc, anchorHex)
      const [orphanedBlock] = await rpc('generatetoaddress', [1, miningAddress])
      for (const index of [3, 4, 5]) assert.equal(await original.getNewAddress(), expectedAddress(seed, bip, `0'/0/${index}`))
      const survivingAddress = expectedAddress(seed, bip, "0'/0/5")
      const survivingHex = await signedMinerTransaction(rpc, inputs[1], {
        [survivingAddress]: bitcoin(50000n),
        [miningAddress]: bitcoin(sats(inputs[1].amount) - 50000n - 1000n)
      })
      const surviving = await acceptAndBroadcast(rpc, survivingHex)
      await rpc('generatetoaddress', [1, miningAddress])
      assert.equal(await original.getBalance(), 60000n)
      const snapshot = await originalStore.load()
      originalWallet.dispose()

      await rpc('invalidateblock', [orphanedBlock])
      const replacementHex = await signedMinerTransaction(rpc, inputs[0], {
        [miningAddress]: bitcoin(sats(inputs[0].amount) - 10000n)
      })
      const replacement = await acceptAndBroadcast(rpc, replacementHex)
      let mempool = await rpc('getrawmempool')
      if (!mempool.includes(surviving)) await acceptAndBroadcast(rpc, survivingHex)
      mempool = await rpc('getrawmempool')
      assert.equal(mempool.includes(anchor), false)
      assert.equal(mempool.includes(surviving), true)
      assert.equal(mempool.includes(replacement), true)
      const [replacementBlock] = await rpc('generatetoaddress', [1, miningAddress])
      assert.notEqual(replacementBlock, orphanedBlock)
      const canonicalBlock = await rpc('getblock', [replacementBlock])
      assert.equal(canonicalBlock.tx.includes(anchor), false)
      assert.equal(canonicalBlock.tx.includes(surviving), true)
      assert.equal(canonicalBlock.tx.includes(replacement), true)
      assert.equal((await rpc('getblockheader', [orphanedBlock])).confirmations, -1)
      assert.equal(await rpc('gettxout', [anchor, 0]), null)
      assert.equal(sats((await rpc('gettxout', [surviving, 0])).value), 50000n)

      // The test client deliberately models only a forward-moving chain. A new
      // instance rebuilds its index from the actual canonical fork on restart.
      const canonical = new BitcoinCoreClient(rpc, miningAddress)
      assert.deepEqual(await canonical.getHistory(anchorAddress), [])
      assert.equal((await canonical.getHistory(survivingAddress))[0].tx_hash, surviving)
      const restoredStore = new JsonFileStateStore(join(directory, `restored-${bip}.json`))
      assert.equal(await restoredStore.compareAndSwap(null, snapshot), true)
      const restoredWallet = new WalletManagerBtc(seed, { network: 'regtest', bip, client: canonical })
      wallets.push(restoredWallet)
      const restored = await restoredWallet.getHdAccount(0, { ...options, stateStore: restoredStore })
      assert.equal(await restored.getBalance(), 50000n)
      const emptyStore = new JsonFileStateStore(join(directory, `empty-${bip}.json`))
      const seedWallet = new WalletManagerBtc(seed, { network: 'regtest', bip, client: canonical })
      wallets.push(seedWallet)
      const seedOnly = await seedWallet.getHdAccount(0, { ...options, stateStore: emptyStore })
      assert.equal(await seedOnly.getBalance(), 0n)
      const expandedWallet = new WalletManagerBtc(seed, { network: 'regtest', bip, client: canonical })
      wallets.push(expandedWallet)
      const expanded = await expandedWallet.getHdAccount(0, { ...options, gapLimit: 6, stateStore: emptyStore })
      assert.equal(await expanded.getBalance(), 50000n)
      assert.equal(await emptyStore.load(), null)

      const recovered = await restored.sendTransaction({ to: miningAddress, value: 10000n, feeRate: 2 })
      const recoveredTx = await canonical.inspectTransaction(canonical.broadcasts[0])
      assert.equal(recoveredTx.inputs.length, 1)
      assert.equal(recoveredTx.inputs[0].address, survivingAddress)
      assert.equal(recoveredTx.outputs[0].value, 10000n)
      await canonical.mine()
      assert.equal((await restored.getTransaction(recovered.hash)).finality, 'confirmed')
      assert.equal(await restored.getBalance(), 40000n - recovered.fee)
      results.push({
        bip,
        orphanedBlock,
        replacementBlock,
        anchor,
        surviving,
        replacement,
        savedStateRecoveredSats: 50000,
        seedOnlyGap3BalanceSats: 0,
        explicitGap6RecoveredSats: 50000,
        recoverySpend: recovered.hash,
        recoverySpendAcceptedAndMined: true
      })
      console.log(`BIP${bip}: real fork removed the allocation anchor; backup/explicit-gap recovery and the recovery spend passed`)
    } finally {
      try {
        for (const wallet of wallets) wallet.dispose()
      } finally { seed.fill(0) }
    }
  }
  const info = await node.rpc('getnetworkinfo')
  assert.equal(info.networkactive, false)
  assert.equal(info.connections, 0)
  const report = { checkedAt: new Date().toISOString(), bitcoinCoreVersion: info.version, chain: 'regtest', peerNetworking: false, results }
  if (process.env.WDK_RECOVERY_RESULT) await writeFile(process.env.WDK_RECOVERY_RESULT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { await node?.stop() } finally { await rm(directory, { recursive: true, force: true }) }
}
