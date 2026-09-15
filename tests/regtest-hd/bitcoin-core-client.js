// Copyright 2024 Tether Operations Limited
// Licensed under the Apache License, Version 2.0. See LICENSE.

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const sats = amount => BigInt(Math.round(amount * 100_000_000))

async function availablePort () {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

/**
 * Starts only an isolated regtest node, with peer networking disabled.
 * The caller supplies a previously verified local Bitcoin Core binary.
 * Cookie authentication and wallet keys live only in the temporary datadir.
 */
export async function startBitcoinCore (bitcoindPath) {
  await access(bitcoindPath, constants.X_OK)
  const port = await availablePort()
  const directory = await mkdtemp(join(tmpdir(), 'wdk-hd-bitcoin-core-'))
  const child = spawn(bitcoindPath, [
    '-regtest', '-server=1', '-networkactive=0', '-listen=0', '-connect=0',
    '-dnsseed=0', '-discover=0', '-txindex=1', '-fallbackfee=0.00002',
    '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`,
    `-datadir=${directory}`, '-printtoconsole=0'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let startupError
  let stderr = ''
  child.on('error', error => { startupError = error })
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
  const exited = new Promise(resolve => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  let cookie
  const rpc = async (method, params = [], wallet) => {
    const response = await fetch(`http://127.0.0.1:${port}/${wallet ? `wallet/${encodeURIComponent(wallet)}` : ''}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'wdk-regtest', method, params }),
      signal: AbortSignal.timeout(20000)
    })
    const body = await response.json()
    if (body.error) throw new Error(`Bitcoin Core ${method}: ${body.error.message}`)
    if (!response.ok) throw new Error(`Bitcoin Core ${method}: HTTP ${response.status}`)
    return body.result
  }
  const stop = async () => {
    try {
      if (child.exitCode === null && cookie) await rpc('stop')
    } catch {
      child.kill('SIGTERM')
    }
    if (child.exitCode === null && !startupError) {
      await Promise.race([exited, delay(5000, undefined, { ref: false })])
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
    }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError
      if (child.exitCode !== null) throw new Error(`Bitcoin Core failed to start: ${stderr}`)
      try {
        cookie = (await readFile(join(directory, 'regtest', '.cookie'), 'utf8')).trim()
        const info = await rpc('getblockchaininfo')
        if (info.chain !== 'regtest') throw new Error('Refusing to use a non-regtest node')
        ready = true
        break
      } catch (error) {
        if (attempt === 99) throw error
        await delay(100)
      }
    }
    if (!ready) throw new Error('Bitcoin Core startup timed out')
    const network = await rpc('getnetworkinfo')
    if (network.networkactive || network.connections !== 0) throw new Error('Regtest peer networking must remain disabled')
    await rpc('createwallet', ['wdk-regtest-miner'])
    const miningAddress = await rpc('getnewaddress', [], 'wdk-regtest-miner')
    await rpc('generatetoaddress', [101, miningAddress])
    return { rpc, client: new BitcoinCoreClient(rpc, miningAddress), stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/**
 * Test-only IBtcClient backed by a real Core regtest chain and mempool.
 * A small local block index supplies address history without an Electrum server.
 * It assumes this dedicated test chain only advances and does not model reorgs.
 */
export class BitcoinCoreClient {
  constructor (rpc, miningAddress) {
    this.rpc = rpc
    this.miningAddress = miningAddress
    this.broadcasts = []
    this.calls = []
    this._height = 0
    this._confirmed = new Map()
    this._records = new Map()
    this._outputs = new Map()
    this._indexKey = null
    this._refreshing = null
  }

  async connect () {}
  async close () {} // The explicit runner owns the Core process.
  async reconnect () {}
  async estimateFee () { return 0.00002 }
  async getBlockHeight () { return this.rpc('getblockcount') }

  async fund (address, value) {
    const txid = await this.rpc('sendtoaddress', [address, Number(value) / 100_000_000], 'wdk-regtest-miner')
    this._indexKey = null
    return txid
  }

  async mine () {
    await this.rpc('generatetoaddress', [1, this.miningAddress])
    this._indexKey = null
    return this.getBlockHeight()
  }

  async _refresh () {
    if (this._refreshing) return this._refreshing
    const work = this._refreshIndex()
    this._refreshing = work
    try { await work } finally { this._refreshing = null }
  }

  async _refreshIndex () {
    const height = await this.getBlockHeight()
    const mempool = (await this.rpc('getrawmempool')).sort()
    const key = `${height}:${mempool.join(',')}`
    if (this._indexKey === key) return
    for (let blockHeight = this._height + 1; blockHeight <= height; blockHeight++) {
      const hash = await this.rpc('getblockhash', [blockHeight])
      const block = await this.rpc('getblock', [hash, 2])
      for (const tx of block.tx) this._confirmed.set(tx.txid, { tx, height: blockHeight, blockhash: hash })
    }
    this._height = height
    this._records = new Map(this._confirmed)
    for (const txid of mempool) {
      const tx = await this.rpc('getrawtransaction', [txid, true])
      this._records.set(txid, { tx, height: 0 })
    }
    this._outputs = new Map()
    for (const [txid, record] of this._records) {
      record.addresses = new Set()
      for (const output of record.tx.vout) {
        const address = output.scriptPubKey.address
        if (address) record.addresses.add(address)
        this._outputs.set(`${txid}:${output.n}`, {
          txid, vout: output.n, address, value: sats(output.value), height: record.height, spent: false
        })
      }
    }
    for (const record of this._records.values()) {
      for (const input of record.tx.vin) {
        if (input.coinbase) continue
        const output = this._outputs.get(`${input.txid}:${input.vout}`)
        if (!output) throw new Error('Regtest index is missing a previous output')
        output.spent = true
        if (output.address) record.addresses.add(output.address)
      }
    }
    this._indexKey = key
  }

  async getHistory (address) {
    this.calls.push({ method: 'getHistory', address })
    await this._refresh()
    return [...this._records]
      .filter(([, record]) => record.addresses.has(address))
      .map(([txid, record]) => ({ tx_hash: txid, height: record.height }))
  }

  async listUnspent (address) {
    this.calls.push({ method: 'listUnspent', address })
    await this._refresh()
    return [...this._outputs.values()]
      .filter(output => !output.spent && output.address === address)
      .map(output => ({ tx_hash: output.txid, tx_pos: output.vout, value: Number(output.value), height: output.height }))
  }

  async getBalance (address) {
    const outputs = await this.listUnspent(address)
    return {
      confirmed: outputs.filter(output => output.height > 0).reduce((sum, output) => sum + output.value, 0),
      unconfirmed: outputs.filter(output => output.height === 0).reduce((sum, output) => sum + output.value, 0)
    }
  }

  async getTransaction (txid) {
    await this._refresh()
    const record = this._records.get(txid)
    return this.rpc('getrawtransaction', record?.blockhash ? [txid, false, record.blockhash] : [txid, false])
  }

  async inspectTransaction (hex) {
    await this._refresh()
    const tx = await this.rpc('decoderawtransaction', [hex])
    const inputs = tx.vin.map(input => {
      const output = this._outputs.get(`${input.txid}:${input.vout}`)
      if (!output) throw new Error('Unknown inspected regtest input')
      return { txid: input.txid, vout: input.vout, address: output.address, value: output.value }
    })
    const outputs = tx.vout.map(output => ({ index: output.n, address: output.scriptPubKey.address, value: sats(output.value) }))
    const inputValue = inputs.reduce((sum, input) => sum + input.value, 0n)
    const outputValue = outputs.reduce((sum, output) => sum + output.value, 0n)
    return { txid: tx.txid, fee: inputValue - outputValue, inputValue, outputValue, inputs, outputs, vsize: tx.vsize }
  }

  async broadcast (hex) {
    const [result] = await this.rpc('testmempoolaccept', [[hex]])
    if (!result.allowed) throw new Error(`Core rejected transaction: ${result['reject-reason'] ?? result['package-error']}`)
    const txid = await this.rpc('sendrawtransaction', [hex])
    this.broadcasts.push(hex)
    this._indexKey = null
    return txid
  }
}
