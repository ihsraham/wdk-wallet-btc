/** @typedef {import('./transports/index.js').BtcUtxo} BtcUtxo */
/** @typedef {import('./transports/index.js').BtcHistoryItem} BtcHistoryItem */
/**
 * Adapts the existing account-wide read methods to a discovered HD address set.
 * Signing, reservation and discovery policy remain in the HD account.
 * @internal
 */
export default class HdAccountClient extends IBtcClient {
    /** @param {IBtcClient} client @param {() => Promise<{available: BtcUtxo[], history: BtcHistoryItem[]}>} discover */
    constructor(client: IBtcClient, discover: () => Promise<{
        available: BtcUtxo[];
        history: BtcHistoryItem[];
    }>);
    _client: IBtcClient;
    _discover: () => Promise<{
        available: BtcUtxo[];
        history: BtcHistoryItem[];
    }>;
    estimateFee(target: any): Promise<number>;
    getTransaction(hash: any): Promise<string>;
    broadcast(hex: any): Promise<string>;
    listUnspent(): Promise<import("./transports/btc-client.js").BtcUtxo[]>;
    getBalance(): Promise<{
        confirmed: number;
        unconfirmed: number;
        unconfirmedOutgoing: number;
    }>;
    getHistory(): Promise<import("./transports/btc-client.js").BtcHistoryItem[]>;
}
export type BtcUtxo = import("./transports/index.js").BtcUtxo;
export type BtcHistoryItem = import("./transports/index.js").BtcHistoryItem;
import IBtcClient from './transports/btc-client.js';
