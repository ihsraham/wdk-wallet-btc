# HD account behavior tests

Run these tests without bitcoind, Electrs or Jest's global setup:

```sh
node --test tests/hd/*.test.js
```

The tests exercise the public manager/account API against an independent Bitcoin
client. They derive expected BIP-44 and BIP-84 addresses with `bip32` and decode the
resulting transactions with `bitcoinjs-lib`. The client verifies P2WPKH and
compressed-key P2PKH input ownership and signatures, and computes fees from the
recorded previous outputs. It tracks histories and UTXOs across receiving,
internal and external addresses.

Each test generates temporary random seeds or private keys and wipes its owned
buffers during cleanup. No production keys, RPC services or transactions are used.

The file-backed test store shares a serialized compare-and-swap boundary across
separate handles in one process. Successful writes are atomically renamed and
survive manager recreation. This adapter is **not** a production durable-store
implementation: it does not establish cross-process locking, fsync or power-loss
guarantees.

The simulated chain supports confirmed/pending funding, signed spends and mining.
Funding is synthetic and does not enforce coinbase maturity. Input validation
covers BIP-84 P2WPKH and BIP-44 compressed-key P2PKH with SIGHASH_ALL. These tests
do not cover other input scripts, Bitcoin consensus, relay policy, RBF, reorgs,
timelocks, hardware devices or real provider integration. Run the existing
integration suite separately for its covered provider and node behavior.

See [recovery validation](../recovery/README.md) for the tested backup, gap and
reorg conditions, the separate Core recovery runner, and remaining recovery limits.
