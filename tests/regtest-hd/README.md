# Explicit Bitcoin Core regtest check

This optional runner is separate from the offline test suite. Supply a Bitcoin
Core executable that you have verified for your platform:

```sh
BITCOIND_PATH=/absolute/path/to/bitcoind node tests/regtest-hd/verify.js
```

Set `WDK_REGTEST_RESULT=/absolute/path/to/result.json` to save a successful run's
summary. No success summary is written if a check fails.

The runner creates a temporary datadir and wallet, binds cookie-authenticated RPC
to an ephemeral loopback port, disables peer networking, and asserts the chain is
regtest. It mines funding and validates BIP-44 and BIP-84 spends with Bitcoin
Core's mempool acceptance and mining. Each BIP sends to P2PKH, P2SH-P2WPKH,
P2WPKH and P2TR destinations, for sixteen accepted and mined spends. It checks
signatures, transaction values,
internal change, receiving plus change inputs, confirmed balances, history, and
seed-only recovery with a new allocation store. Keys and node data are temporary;
the runner stops its node and removes its own datadir on completion or failure.

The small test client indexes the dedicated chain for address queries. It assumes
the chain advances without reorgs and does not cover Electrum providers, RBF,
hardware signers, cross-process storage, or production operational behavior.

This runner requires a permitted local executable and loopback sockets. Its
presence or passing syntax checks do not establish a successful Core run. Use the
offline suite separately for its synthetic funding and signature checks:

```sh
node --test tests/hd/*.test.js
```

For the separate real-fork recovery scenario, run
`BITCOIND_PATH=/absolute/path/to/bitcoind npm run test:hd:recovery`. See
[recovery validation](../recovery/README.md) for its backup and scan assumptions.
