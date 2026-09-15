/** @typedef {import('bitcoinjs-lib').Psbt} Psbt */
/** @typedef {import('@tetherto/wdk-wallet').UnsupportedOperationError} UnsupportedOperationError */
/**
 * @typedef {Object} BtcSignerConfig
 * @property {"bitcoin" | "regtest" | "testnet"} [network] - The name of the network to use (default: "bitcoin").
 * @property {44 | 84} [bip] - The BIP address type used for key and address derivation.
 *   - 44: [BIP-44 (P2PKH / legacy)](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki)
 *   - 84: [BIP-84 (P2WPKH / native SegWit)](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki)
 *   - Default: 84 (P2WPKH).
 */
/**
 * Interface for Bitcoin signers, extending the base `ISigner` from `@tetherto/wdk-wallet`.
 *
 * @interface
 */
export class ISignerBtc extends ISigner {
    /**
     * The account's address, if available.
     *
     * @deprecated Use {@link getAddress} instead. This property will be removed in an upcoming
     * release: not all signers (e.g. hardware signers) can expose the address synchronously.
     * @type {string | undefined}
     */
    get address(): string | undefined;
    /**
     * The name of the network the signer's addresses are encoded for.
     *
     * @type {"bitcoin" | "regtest" | "testnet"}
     */
    get network(): "bitcoin" | "regtest" | "testnet";
    /**
     * The BIP address type of the signer's addresses (44 for P2PKH, 84 for P2WPKH).
     *
     * @type {44 | 84}
     */
    get bip(): 44 | 84;
    /**
     * Returns the extended public key (e.g. xpub/tpub).
     *
     * @returns {Promise<string>} The extended public key in base58 format.
     * @throws {UnsupportedOperationError} If the signer does not support extended keys.
     */
    getExtendedPublicKey(): Promise<string>;
    /**
     * Signs a PSBT (Partially Signed Bitcoin Transaction).
     *
     * @param {Psbt | string} psbt - The PSBT instance or base64 string.
     * @returns {Promise<string>} The signed PSBT in base64 format.
     */
    signPsbt(psbt: Psbt | string): Promise<string>;
}
export type Psbt = import("bitcoinjs-lib").Psbt;
export type UnsupportedOperationError = import("@tetherto/wdk-wallet").UnsupportedOperationError;
export type BtcSignerConfig = {
    /**
     * - The name of the network to use (default: "bitcoin").
     */
    network?: "bitcoin" | "regtest" | "testnet";
    /**
     * - The BIP address type used for key and address derivation.
     * - 44: [BIP-44 (P2PKH / legacy)](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki)
     * - 84: [BIP-84 (P2WPKH / native SegWit)](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki)
     * - Default: 84 (P2WPKH).
     */
    bip?: 44 | 84;
};
import { ISigner } from '@tetherto/wdk-wallet';
