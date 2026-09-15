// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { networks, payments, Transaction } from 'bitcoinjs-lib'
import WalletManagerBtc from '../../src/wallet-manager-btc.js'
import { JsonFileStateStore } from '../hd/helpers.js'
import { startBitcoinCore } from './bitcoin-core-client.js'

if (!process.env.BITCOIND_PATH) throw new Error('Set BITCOIND_PATH to a verified Bitcoin Core binary before running this explicit regtest check')

const bip32 = BIP32Factory(ecc)
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

const directory = await mkdtemp(join(tmpdir(), 'wdk-core-hd-state-'))
let node
const cases = []
try {
  node = await startBitcoinCore(process.env.BITCOIND_PATH)
  for (const { bip, addressType } of [44, 84].flatMap(bip => ['legacy', 'p2sh-segwit', 'bech32', 'bech32m'].map(addressType => ({ bip, addressType })))) {
    const seed = randomBytes(64)
    let wallet, restoredWallet
    try {
      const { client, rpc } = node
      const config = { network: 'regtest', bip, client }
      const options = { gapLimit: 3, maxAddresses: 50, stateStore: new JsonFileStateStore(join(directory, `state-${bip}-${addressType}.json`)) }
      wallet = new WalletManagerBtc(seed, config)
      const hd = await wallet.getHdAccount(0, options)
      const external = expectedAddress(seed, bip, "0'/0/0")
      const internal = expectedAddress(seed, bip, "0'/1/0")
      assert.equal(await hd.getAddress(), external)
      await client.fund(external, 100000n)
      await client.fund(internal, 50000n)
      await client.mine()
      assert.equal(await hd.getBalance(), 150000n)
      assert.equal(await (await wallet.getAccount(0)).getBalance(), 100000n)
      const destination = await rpc('getnewaddress', ['', addressType], 'wdk-regtest-miner')
      const broadcastIndex = client.broadcasts.length
      const first = await hd.sendTransaction({ to: destination, value: 110000n, feeRate: 2 })
      const firstHex = client.broadcasts[broadcastIndex]
      const firstTx = await client.inspectTransaction(firstHex)
      assert.equal(first.hash, firstTx.txid)
      assert.equal(first.fee, firstTx.fee)
      assert.deepEqual(firstTx.inputs.map(input => input.address).sort(), [external, internal].sort())
      assert.deepEqual(firstTx.outputs.map(output => output.address), [destination, expectedAddress(seed, bip, "0'/1/1")])
      assert.equal(firstTx.outputs[0].value, 110000n)
      assert.ok(first.fee >= BigInt(firstTx.vsize * 2))
      await client.mine()
      const receipt = await hd.getTransaction(first.hash)
      assert.equal(receipt.finality, 'confirmed')
      assert.equal(receipt.confirmations, 1)
      assert.equal(await hd.getBalance(), 40000n - first.fee)
      wallet.dispose()
      wallet = null

      // A fresh reservation file forces recovery from real chain history.
      restoredWallet = new WalletManagerBtc(seed, config)
      const restored = await restoredWallet.getHdAccount(0, {
        ...options, stateStore: new JsonFileStateStore(join(directory, `restored-${bip}-${addressType}.json`))
      })
      assert.equal(await restored.getBalance(), 40000n - first.fee)
      const signed = await restored.signTransaction({ to: destination, value: 10000n, feeRate: 2 })
      const altered = Transaction.fromHex(signed)
      altered.outs[0].value -= 1n
      const [invalid] = await rpc('testmempoolaccept', [[altered.toHex()]])
      assert.equal(invalid.allowed, false, 'Core must reject altered signed outputs')
      const second = await restored.sendTransaction(signed)
      const secondTx = await client.inspectTransaction(signed)
      assert.equal(second.fee, secondTx.fee)
      assert.deepEqual(secondTx.inputs.map(input => input.address), [expectedAddress(seed, bip, "0'/1/1")])
      assert.deepEqual(secondTx.outputs.map(output => output.address), [destination, expectedAddress(seed, bip, "0'/1/2")])
      assert.equal(secondTx.outputs[0].value, 10000n)
      await client.mine()
      assert.equal(await restored.getBalance(), 30000n - first.fee - second.fee)
      const transfers = await restored.getTransfers({ direction: 'outgoing', limit: 100 })
      assert.deepEqual(transfers.map(row => [row.txid, row.value]).sort(), [[first.hash, 110000n], [second.hash, 10000n]].sort())
      cases.push({ bip, addressType, acceptedAndMinedTransactions: 2, multiKeyInputCount: firstTx.inputs.length, firstFeeSats: Number(first.fee), secondFeeSats: Number(second.fee), alteredSignatureRejected: true, seedOnlyChangeRecovery: true })
      console.log(`BIP${bip} → ${addressType}: Core accepted/mined both spends; multi-key signing and seed-only change recovery passed`)
    } finally {
      try {
        wallet?.dispose()
      } finally {
        try { restoredWallet?.dispose() } finally { seed.fill(0) }
      }
    }
  }
  const info = await node.rpc('getnetworkinfo')
  assert.equal(info.networkactive, false)
  assert.equal(info.connections, 0)
  const report = { checkedAt: new Date().toISOString(), bitcoinCoreVersion: info.version, chain: 'regtest', peerNetworking: false, cases }
  if (process.env.WDK_REGTEST_RESULT) await writeFile(process.env.WDK_REGTEST_RESULT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { await node?.stop() } finally { await rm(directory, { recursive: true, force: true }) }
}
