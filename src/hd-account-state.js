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

import { ValueError } from '@tetherto/wdk-wallet'

/**
 * @typedef {Object} HdReservation
 * @property {number} id - Unique reservation revision.
 * @property {string[]} outpoints - Reserved pairs with lowercase transaction IDs and canonical decimal output indices, separated by a colon.
 * @property {string | null} txid - Lowercase signed transaction ID, or null while preparing it.
 * @property {number | null} changeIndex - Reserved internal address index, if needed.
 */

/**
 * @typedef {Object} HdAccountState
 * @property {1} version - Storage schema version.
 * @property {number} revision - Monotonically increasing compare-and-swap revision.
 * @property {string} accountId - Receiving address 0/0 binding the store to this account.
 * @property {number} nextReceiveIndex - Next receiving index, never decreased on release.
 * @property {number} nextChangeIndex - Next internal index, never decreased on release.
 * @property {HdReservation[]} reservations - Input and change reservations retained across confirmation until explicitly released.
 */

/**
 * Durable storage dedicated to one HD account. All writers must share this store.
 * Replacements must be atomic and durable before resolving true; never roll back a revision.
 *
 * @typedef {Object} HdAccountStateStore
 * @property {() => Promise<HdAccountState | null>} load - Reads the current state.
 * @property {(expectedRevision: number | null, nextState: HdAccountState) => Promise<boolean>} compareAndSwap - Replaces only the expected revision; null means absent.
 */

export const MAX_MONEY = 2100000000000000n

/** @param {unknown} value @param {number} maximum @returns {boolean} */
export function isIndex (value, maximum = 0x7fffffff) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

/** @param {unknown} value @returns {bigint} */
export function satoshis (value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ValueError('Invalid Bitcoin output value.')
  if (!['number', 'bigint', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) throw new ValueError('Invalid Bitcoin output value.')
  const amount = BigInt(value)
  if (amount > MAX_MONEY) throw new ValueError('Bitcoin output exceeds the maximum supply.')
  return amount
}

/** @param {unknown} value @returns {boolean} */
export function isTxid (value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

/** @param {HdAccountState | null} state @param {string} accountId @param {number} maxAddresses @returns {HdAccountState | null} */
export function validateState (state, accountId, maxAddresses) {
  if (state === null) return null
  if (!state || state.version !== 1 || state.accountId !== accountId || !isIndex(state.revision, Number.MAX_SAFE_INTEGER - 1) ||
      !isIndex(state.nextReceiveIndex, maxAddresses) || state.nextReceiveIndex < 1 || !isIndex(state.nextChangeIndex, maxAddresses) ||
      !Array.isArray(state.reservations) || state.reservations.length > maxAddresses * 2) {
    throw new ValueError('Invalid HD account reservation state or mismatched account store.')
  }
  const ids = new Set()
  const outpoints = new Set()
  for (const reservation of state.reservations) {
    if (!reservation || !isIndex(reservation.id, state.revision) || ids.has(reservation.id) ||
        !(reservation.txid === null || (isTxid(reservation.txid) && reservation.txid === reservation.txid.toLowerCase())) ||
        !(reservation.changeIndex === null || isIndex(reservation.changeIndex, state.nextChangeIndex - 1)) ||
        !Array.isArray(reservation.outpoints) || !reservation.outpoints.length || reservation.outpoints.length > 200) {
      throw new ValueError('Invalid HD account reservation.')
    }
    ids.add(reservation.id)
    for (const outpoint of reservation.outpoints) {
      if (typeof outpoint !== 'string' || !/^[a-f0-9]{64}:(0|[1-9][0-9]*)$/.test(outpoint) ||
          !isIndex(Number(outpoint.split(':')[1]), 0xffffffff) || outpoints.has(outpoint)) {
        throw new ValueError('Invalid or duplicate reserved Bitcoin input.')
      }
      outpoints.add(outpoint)
    }
  }
  return structuredCopy(state)
}

/** JSON metadata only; never contains signing material. @template T @param {T} value @returns {T} */
export function structuredCopy (value) {
  return JSON.parse(JSON.stringify(value))
}

/** @param {string} accountId @returns {HdAccountState} */
export function initialState (accountId) {
  return { version: 1, revision: 0, accountId, nextReceiveIndex: 1, nextChangeIndex: 0, reservations: [] }
}
