/** @param {unknown} value @param {number} maximum @returns {boolean} */
export function isIndex(value: unknown, maximum?: number): boolean;
/** @param {unknown} value @returns {bigint} */
export function satoshis(value: unknown): bigint;
/** @param {unknown} value @returns {boolean} */
export function isTxid(value: unknown): boolean;
/** @param {HdAccountState | null} state @param {string} accountId @param {number} maxAddresses @returns {HdAccountState | null} */
export function validateState(state: HdAccountState | null, accountId: string, maxAddresses: number): HdAccountState | null;
/** JSON metadata only; never contains signing material. @template T @param {T} value @returns {T} */
export function structuredCopy<T>(value: T): T;
/** @param {string} accountId @returns {HdAccountState} */
export function initialState(accountId: string): HdAccountState;
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
export const MAX_MONEY: 2100000000000000n;
export type HdReservation = {
    /**
     * - Unique reservation revision.
     */
    id: number;
    /**
     * - Reserved pairs with lowercase transaction IDs and canonical decimal output indices, separated by a colon.
     */
    outpoints: string[];
    /**
     * - Lowercase signed transaction ID, or null while preparing it.
     */
    txid: string | null;
    /**
     * - Reserved internal address index, if needed.
     */
    changeIndex: number | null;
};
export type HdAccountState = {
    /**
     * - Storage schema version.
     */
    version: 1;
    /**
     * - Monotonically increasing compare-and-swap revision.
     */
    revision: number;
    /**
     * - Receiving address 0/0 binding the store to this account.
     */
    accountId: string;
    /**
     * - Next receiving index, never decreased on release.
     */
    nextReceiveIndex: number;
    /**
     * - Next internal index, never decreased on release.
     */
    nextChangeIndex: number;
    /**
     * - Input and change reservations retained across confirmation until explicitly released.
     */
    reservations: HdReservation[];
};
/**
 * Durable storage dedicated to one HD account. All writers must share this store.
 * Replacements must be atomic and durable before resolving true; never roll back a revision.
 */
export type HdAccountStateStore = {
    /**
     * - Reads the current state.
     */
    load: () => Promise<HdAccountState | null>;
    /**
     * - Replaces only the expected revision; null means absent.
     */
    compareAndSwap: (expectedRevision: number | null, nextState: HdAccountState) => Promise<boolean>;
};
