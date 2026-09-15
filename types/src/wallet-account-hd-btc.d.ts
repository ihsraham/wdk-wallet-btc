/**
 * Opt-in account covering one HD account root's receiving and change branches.
 * Balance and spending include confirmed, unreserved UTXOs only. Pending change
 * becomes spendable after confirmation. Legacy single-address accounts are unchanged.
 */
export default class WalletAccountHdBtc extends WalletAccountBtc {
    /**
     * Creates an HD account from a borrowed account-root signer. The manager uses this
     * factory with an owned derived root. Callers must not transact through overlapping
     * leaf accounts or use independent reservation stores for the same HD account.
     *
     * @param {ISignerBtc} rootSigner - Derivable signer at the chosen account root.
     * @param {BtcWalletConfig & HdAccountOptions} config - Account, transport and storage options.
     * @param {boolean} [ownsRoot=false] - Whether this account should dispose the root.
     * @returns {Promise<WalletAccountHdBtc>}
     */
    static create(rootSigner: ISignerBtc, config: BtcWalletConfig & HdAccountOptions, ownsRoot?: boolean): Promise<WalletAccountHdBtc>;
    /** @private @param {ISignerBtc} rootSigner @param {ISignerBtc} firstSigner @param {BtcWalletConfig & HdAccountOptions} config @param {boolean} ownsRoot */
    private constructor();
    /** @private */
    private _rootSigner;
    /** @private */
    private _ownsRoot;
    /** @private */
    private _stateStore;
    /** @private */
    private _gapLimit;
    /** @private */
    private _maxAddresses;
    /** @private */
    private _accountId;
    /** @private */
    private _addresses;
    /** @private */
    private _operation;
    /** @private */
    private _disposed;
    /** @private */
    private _hdClient;
    /** No single key represents an HD account. @returns {null} */
    get keyPair(): null;
    /**
     * Reserves and returns a new receiving address. Fails when unused reservations
     * would create a gap that seed-only restoration cannot recover.
     * @returns {Promise<string>}
     */
    getNewAddress(): Promise<string>;
    /** Returns detached public reservation metadata. @returns {Promise<HdReservation[]>} */
    getReservations(): Promise<HdReservation[]>;
    /**
     * Releases inputs of an explicitly abandoned transaction, without reusing its
     * address index. Only call when its signed bytes will never be broadcast again.
     * Confirmation or a broadcast timeout is not evidence that release is safe.
     * @param {number} id - Reservation ID returned by getReservations().
     * @returns {Promise<void>}
     */
    releaseReservation(id: number): Promise<void>;
    /**
     * The draft signer contract has no settled public-only discovery capability.
     * Never return a partial address snapshot or retain a signing root behind a read-only wrapper.
     * @returns {Promise<never>}
     * @throws {UnsupportedOperationError} Always for HD accounts.
     */
    toReadOnlyAccount(): Promise<never>;
    /** @private */
    private _assertActive;
    /** @private @template T @param {() => Promise<T>} action @returns {Promise<T>} */
    private _exclusive;
    /** @private */
    private _readState;
    /** @private */
    private _replace;
    /** @private */
    private _deriveAddress;
    /** @private */
    private _discover;
    /** @private */
    private _checkAllocation;
    /** @private */
    private _feeRate;
    /** @private */
    private _planHdSpend;
    /** @private */
    private _checkFee;
    /** @private */
    private _prepareTransaction;
    /** Verifies selected provider data against the transaction committed by its hash. @private */
    private _validatePrevouts;
    /** @private */
    private _updateReservation;
}
export type ISignerBtc = import("./signers/signer-btc.js").ISignerBtc;
export type BtcWalletConfig = import("./wallet-account-read-only-btc.js").BtcWalletConfig;
export type HdAccountStateStore = import("./hd-account-state.js").HdAccountStateStore;
export type HdReservation = import("./hd-account-state.js").HdReservation;
export type HdAccountOptions = {
    /**
     * - Dedicated durable atomic storage shared by every writer of this HD account.
     */
    stateStore: HdAccountStateStore;
    /**
     * - Consecutive unused addresses that stop discovery and bound outstanding address allocation.
     */
    gapLimit?: number;
    /**
     * - Maximum addresses scanned per branch. Exhaustion fails explicitly.
     */
    maxAddresses?: number;
    /**
     * - Registered derivable signer selected by the manager.
     */
    signerName?: string;
};
import WalletAccountBtc from './wallet-account-btc.js';
