/**
 * Returns the relative BIP derivation path prefix (purpose'/coin_type') for the given signer
 * configuration.
 *
 * @internal
 * @param {BtcSignerConfig} [config] - The signer configuration.
 * @returns {string} The derivation path prefix (e.g. "84'/0'").
 * @throws {ValueError} If an unsupported BIP is specified.
 */
export function getBtcDerivationPathPrefix(config?: BtcSignerConfig): string;
/**
 * Signer implementation that derives keys from a BIP-39 seed using an HD path.
 *
 * The path is not required to match the configured BIP purpose; the configuration governs
 * address encoding only.
 *
 * @implements {ISignerBtc}
 */
export default class SeedSignerBtc implements ISignerBtc {
    /**
     * Creates a signer from an extended private key (xprv/tprv). The imported node is the
     * signer's root, at path "m".
     *
     * @param {string} xprv - The extended private key in base58 format.
     * @param {BtcSignerConfig} [config] - The signer configuration.
     * @returns {SeedSignerBtc} The signer instance.
     * @throws {ValueError} If an unsupported BIP is specified.
     */
    static fromXprv(xprv: string, config?: BtcSignerConfig): SeedSignerBtc;
    /** @private */
    private static _init;
    /**
     * Creates a SeedSignerBtc from a BIP-39 seed.
     *
     * @param {string | Buffer} seed - BIP-39 mnemonic or seed bytes.
     * @param {string} [path] - A BIP-32 path (default: the first account for the configured BIP and network, e.g. "m/84'/0'/0'/0/0").
     * @param {BtcSignerConfig} [config] - The signer configuration.
     * @throws {ValueError} If the given seed phrase is invalid.
     * @throws {ValueError} If an unsupported BIP is specified.
     */
    constructor(seed: string | Buffer, path?: string, config?: BtcSignerConfig);
    /**
     * Whether this signer can derive child signers. Always true: every seed signer holds an
     * HD node with a private key and can derive below its own path.
     *
     * @type {true}
     */
    get isDerivable(): true;
    /**
     * The signer's absolute derivation path.
     *
     * @type {string}
     */
    get path(): string;
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
     * The account's key pair (private and public key buffers).
     *
     * @type {KeyPair}
     */
    get keyPair(): KeyPair;
    /**
     * Derives a child signer relative to this signer's own path (e.g. calling derive("0'/0/1") on
     * a signer at "m/84'/0'" yields a child at "m/84'/0'/0'/0/1")
     *
     * @param {string} relPath - The path segment to derive, relative to this signer's own path.
     * @returns {Promise<SeedSignerBtc>} The derived child signer.
     * @throws {InvalidSignerError} If the signer has been disposed.
     */
    derive(relPath: string): Promise<SeedSignerBtc>;
    /**
     * Returns the account's derived address.
     *
     * @returns {Promise<string>} The account's address.
     */
    getAddress(): Promise<string>;
    /**
     * Returns the extended public key (xpub/zpub/tpub/vpub based on network and BIP).
     *
     * @returns {Promise<string>} The extended public key in base58 format.
     */
    getExtendedPublicKey(): Promise<string>;
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
     * Disposes the signer, securely erasing its private key from memory.
     */
    dispose(): void;
    /** @private @type {BIP32Interface | undefined} */
    private _account;
}
export type ISignerBtc = import("./signer-btc.js").ISignerBtc;
export type BtcSignerConfig = import("./signer-btc.js").BtcSignerConfig;
export type KeyPair = import("@tetherto/wdk-wallet").KeyPair;
export type BIP32Interface = import("bip32").BIP32Interface;
export type Network = import("bitcoinjs-lib").Network;
import { Psbt } from 'bitcoinjs-lib';
