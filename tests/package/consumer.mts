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
import WalletManagerBtc, {
  WalletAccountBtc, WalletAccountReadOnlyBtc, WalletAccountHdBtc,
  type BtcTransaction, type BtcTransfer, type HdAccountOptions,
  type HdAccountState, type HdAccountStateStore, type HdReservation,
  type TransferOptions, type FeeRates, type KeyPair,
} from '@tetherto/wdk-wallet-btc';
import SeedSignerBtc, { PrivateKeySignerBtc, ISignerBtc } from '@tetherto/wdk-wallet-btc/signers';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;
type BalanceIsTyped = Assert<NotAny<Awaited<ReturnType<WalletAccountHdBtc['getBalance']>>>>;
type TokenArgumentIsTyped = Assert<NotAny<Parameters<WalletAccountReadOnlyBtc['getTokenBalance']>[0]>>;
type QuoteArgumentIsTyped = Assert<NotAny<Parameters<WalletAccountReadOnlyBtc['quoteTransfer']>[0]>>;
type StateIsTyped = Assert<NotAny<Awaited<ReturnType<HdAccountStateStore['load']>>>>;
type TransactionIsTyped = Assert<NotAny<Parameters<WalletAccountHdBtc['signTransaction']>[0]>>;
type SignerIsTyped = Assert<NotAny<Awaited<ReturnType<ISignerBtc['signPsbt']>>>>;

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const manager = new WalletManagerBtc(mnemonic, { network: 'regtest', bip: 84 });
const signer = new SeedSignerBtc(mnemonic, "m/84'/1'");
const signerManager = new WalletManagerBtc(signer);
const importedSigner: ISignerBtc = SeedSignerBtc.fromXprv('tprv-placeholder');
const privateSigner = new PrivateKeySignerBtc(new Uint8Array(32));
const leaf: WalletAccountBtc = await manager.getAccount(0);
const leafDefault: WalletAccountBtc = await manager.getAccount();
const leafNamed: WalletAccountBtc = await manager.getAccount('registered');
const leafSelected: WalletAccountBtc = await manager.getAccount(1, { signerName: 'registered' });
const leafPath: WalletAccountBtc = await manager.getAccountByPath("0'/0/1");
const leafKeys: KeyPair | null = leaf.keyPair;
const rates: FeeRates = await manager.getFeeRates();
const normalFee: bigint = rates.normal;
const readOnly = new WalletAccountReadOnlyBtc('bcrt1q-placeholder', { network: 'regtest' });
const balance: bigint = await readOnly.getBalance();
const tokenBalance: bigint = await readOnly.getTokenBalance('token-placeholder');
const transfer: TransferOptions = { token: 'token', recipient: 'recipient', amount: 1n };
const quoteFee: bigint = (await readOnly.quoteTransfer(transfer)).fee;

// In-memory implementation is only a compile-time shape fixture, not a production store.
let savedState: HdAccountState | null = null;
const store: HdAccountStateStore = {
  async load() { return savedState; },
  async compareAndSwap(expectedRevision, nextState) {
    if ((savedState?.revision ?? null) !== expectedRevision) return false;
    savedState = nextState;
    return true;
  },
};
const hdOptions: HdAccountOptions = { stateStore: store, gapLimit: 20, maxAddresses: 1000 };
const hd: WalletAccountHdBtc = await manager.getHdAccount(0, hdOptions);
const hdDefault = await manager.getHdAccount(undefined, hdOptions);
const hdPath = await manager.getHdAccountByPath("0'", { ...hdOptions, signerName: 'registered' });
const hdFactory = await WalletAccountHdBtc.create(signer, { ...hdOptions, network: 'regtest' });
const noSingleKey: null = hd.keyPair;
const hdRootPath: string | null = hd.path;
const address: string = await hd.getAddress();
const nextAddress: string = await hd.getNewAddress();
const available: bigint = await hd.getBalance();
const messageSignature: string = await hd.sign('message');
const tx: BtcTransaction = { to: address, value: 1000n, feeRate: 2 };
const signed: string = await hd.signTransaction(tx);
const reservations: HdReservation[] = await hd.getReservations();
await hd.releaseReservation(reservations[0].id);
const sendHash: string = (await hd.sendTransaction(tx)).hash;
const rawSendHash: string = (await hd.sendTransaction(signed, 1000)).hash;
const sendQuote: bigint = (await hd.quoteSendTransaction(tx)).fee;
const rawQuote: bigint = (await hd.quoteSendTransaction(signed)).fee;
const maxAmount: bigint = (await hd.getMaxSpendable({ feeRate: 2n })).amount;
const maxDefault: bigint = (await hd.getMaxSpendable()).amount;
const transfers: BtcTransfer[] = await hd.getTransfers({ direction: 'outgoing', limit: 2, skip: 1 });
const unsupportedReadonly: Promise<never> = hd.toReadOnlyAccount();

class SpendShapeProbe extends WalletAccountReadOnlyBtc {
  async probe() {
    const plan = await this._planSpend({ fromAddress: address, toAddress: address, amount: 1n, feeRate: 2 });
    const txid: string = plan.utxos[0].tx_hash;
    const position: number = plan.utxos[0].tx_pos;
    const transportValue: number = plan.utxos[0].value;
    const prevoutValue: bigint = plan.utxos[0].vout.value;
    const script: string = plan.utxos[0].vout.scriptPubKey.hex;
    const fee: bigint = plan.fee;
    type SpendInputIsTyped = Assert<NotAny<typeof plan.utxos[number]>>;
    // @ts-expect-error actual spend inputs are UTXO references, not coinselect OutputWithValue
    plan.utxos[0].output;
    return { txid, position, transportValue, prevoutValue, script, fee };
  }
}

class RawTransactionProbe extends WalletAccountBtc {
  async probe() {
    const plan = await this._planSpend({ fromAddress: address, toAddress: address, amount: 1000n, feeRate: 1 });
    const args = { ...plan, to: address, value: 1000n, feeRate: 1 };
    const result = await this._getRawTransaction(args);
    const fee: bigint = result.fee;
    type RawFeeIsTyped = Assert<NotAny<typeof result.fee>>;
    await this._getRawTransaction({ ...args, changeAddress: address });
    // @ts-expect-error recipient must be an address string
    this._getRawTransaction({ ...args, changeAddress: address, to: 1 });
    // @ts-expect-error payment value cannot be a string
    this._getRawTransaction({ ...args, changeAddress: address, value: '1000' });
    // @ts-expect-error fee rate cannot be a string
    this._getRawTransaction({ ...args, changeAddress: address, feeRate: '1' });
    return fee;
  }
}

// Every expected failure guards a concrete public API contract.
// @ts-expect-error token address remains required
readOnly.getTokenBalance();
// @ts-expect-error token address is a string
readOnly.getTokenBalance(123);
// @ts-expect-error transfer options remain required
readOnly.quoteTransfer();
// @ts-expect-error transfer amount does not accept strings
readOnly.quoteTransfer({ token: 't', recipient: 'r', amount: '1' });
// @ts-expect-error legacy index is numeric or signer name, not an object
manager.getAccount({ index: 0 });
// @ts-expect-error HD state store is required
manager.getHdAccount(0, {});
// @ts-expect-error HD options cannot be omitted
manager.getHdAccount(0);
// @ts-expect-error state store compare-and-swap resolves a boolean
const badStore: HdAccountStateStore = { load: async () => null, compareAndSwap: async () => 1 };
// @ts-expect-error state schema version is fixed at 1
const badVersion: HdAccountState = { version: 2, revision: 0, accountId: address, nextReceiveIndex: 0, nextChangeIndex: 0, reservations: [] };
// @ts-expect-error factory enforces initialization; HD constructor is private
new WalletAccountHdBtc();
// @ts-expect-error signing requires the message
hd.sign();
// @ts-expect-error signing requires a transaction
hd.signTransaction();
// @ts-expect-error transaction value cannot be a string
hd.signTransaction({ to: address, value: '1000' });
// @ts-expect-error raw hex belongs to send/quote, not signTransaction
hd.signTransaction(signed);
// @ts-expect-error reservations use numeric IDs
hd.releaseReservation('1');
// @ts-expect-error direction has a fixed union
hd.getTransfers({ direction: 'both' });
// @ts-expect-error fee rate cannot be a string
hd.getMaxSpendable({ feeRate: '2' });
// @ts-expect-error a fee result is not a string
const wrongFee: string = (await hd.quoteSendTransaction(tx)).fee;
// @ts-expect-error derivation path remains required
signer.derive();
// @ts-expect-error signPsbt requires PSBT or base64 string
signer.signPsbt(10);

// Visibility checks cover source JSDoc privacy and protected members.
// @ts-expect-error root signer is private
hd._rootSigner;
// @ts-expect-error reservation storage is private
hd._stateStore;
// @ts-expect-error manager HD cache is private
manager._hdAccounts;
// @ts-expect-error transaction client is protected
hd._client;
// @ts-expect-error dust limit is private
readOnly._dustLimit;
// @ts-expect-error imported signer key state is private
privateSigner._account;
// @ts-expect-error seed signer key state is private
signer._account;
