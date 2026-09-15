/** @typedef {import('./signer-btc.js').ISignerBtc} ISignerBtc */
/** @typedef {import('./signer-btc.js').BtcSignerConfig} BtcSignerConfig */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/**
 * Signer backed by a single raw private key (non-HD).
 *
 * Does not support HD derivation or extended keys. Signs messages and PSBTs directly using
 * the leaf key.
 *
 * @implements {ISignerBtc}
 */
export default class PrivateKeySignerBtc implements ISignerBtc {
    /**
     * Creates a new private key signer.
     *
     * @param {string | Uint8Array | Buffer} privateKey - The raw private key (hex string or 32 bytes).
     * @param {BtcSignerConfig} [config] - The signer configuration.
     * @throws {ValueError} If the private key is not 32 bytes.
     * @throws {ValueError} If an unsupported BIP is specified.
     */
    constructor(privateKey: string | Uint8Array | Buffer, config?: BtcSignerConfig);
    /**
     * @private
     * @type {BtcSignerConfig}
     */
    private _config;
    /** @private */
    private _network;
    /** @private */
    private _account;
    /** @private */
    private _publicKey;
    /** @private */
    private _address;
    /**
     * Whether this signer can derive child signers.
     *
     * @type {false}
     */
    get isDerivable(): false;
    /**
     * The derivation path. Always null for private-key signers.
     *
     * @type {string | null}
     */
    get path(): string | null;
    /**
     * The account's Bitcoin address.
     *
     * @deprecated Use {@link getAddress} instead. This property will be removed in an upcoming
     * release: not all signers (e.g. hardware signers) can expose the address synchronously.
     * @type {string}
     */
    get address(): string;
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
     * The account's key pair (public and private keys).
     *
     * @type {KeyPair}
     */
    get keyPair(): KeyPair;
    /**
     * Derives a child signer using a relative path (e.g. "0'/0/0").
     *
     * @param {string} path - The relative derivation path.
     * @returns {Promise<never>} The derived signer.
     * @throws {UnsupportedOperationError} If the signer does not support account derivation.
     * @throws {ValueError} If the path is not valid.
     */
    derive(path: string): Promise<never>;
    /**
     * Returns the account's derived address.
     *
     * @returns {Promise<string>} The account's address.
     */
    getAddress(): Promise<string>;
    /**
     * Returns the extended public key (e.g. xpub/tpub).
     *
     * @returns {Promise<never>} The extended public key in base58 format.
     * @throws {UnsupportedOperationError} If the signer does not support extended keys.
     */
    getExtendedPublicKey(): Promise<never>;
    /**
     * Signs a message.
     *
     * @param {string} message - The message to sign.
     * @returns {Promise<string>} The message's signature.
     */
    sign(message: string): Promise<string>;
    /**
     * Signs a PSBT (Partially Signed Bitcoin Transaction).
     *
     * @param {Psbt | string} psbt - The PSBT instance or base64 string.
     * @returns {Promise<string>} The signed PSBT in base64 format.
     */
    signPsbt(psbt: Psbt | string): Promise<string>;
    /**
     * Disposes the signer, securely erasing the private key from memory.
     */
    dispose(): void;
}
export type ISignerBtc = import("./signer-btc.js").ISignerBtc;
export type BtcSignerConfig = import("./signer-btc.js").BtcSignerConfig;
export type KeyPair = import("@tetherto/wdk-wallet").KeyPair;
import { Psbt } from 'bitcoinjs-lib';
