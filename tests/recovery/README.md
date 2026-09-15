# Recovery validation and operating limits

The recovery tests distinguish recoverable on-chain funds from allocation and
reservation metadata that a seed cannot reconstruct.

Run the offline cases with:

```sh
node --test tests/hd/recovery.test.js
```

Run the separate Core checks with a verified local Bitcoin Core binary:

```sh
BITCOIND_PATH=/path/to/verified/bitcoind \
  WDK_RECOVERY_RESULT=/path/to/recovery-result.json \
  node tests/regtest-hd/recovery.js
```

The Core runner creates an isolated regtest datadir, disables peer networking,
uses loopback cookie-authenticated RPC, and removes its temporary data after
stopping the process. Its transactions use only newly mined local regtest funds.

## What the checks establish

The [offline tests](../hd/recovery.test.js) cover six cases:

- Latest allocation state still discovers a funded address after an earlier
  confirmed allocation anchor disappears from canonical history.
- A stale backup can miss an address allocated after that backup.
- A larger explicit gap finds the missing payment; an inadequate scan budget
  fails instead of returning a partial result.
- Saved state rejects a different seed, account root, BIP or network.
- A reduced budget cannot silently truncate persisted issued indices.
- Missing metadata loses an unbroadcast signed-transaction reservation even
  though the seed and on-chain UTXO are unchanged. Both competing signed
  transactions remain valid individually; only one can spend the input.

The [reservation restart tests](../hd/reorg-reservations.test.js) also cover both
BIPs after a confirmed spend disappears from the provider's chain and mempool
view. Current metadata keeps its resurrected input reserved after restart, while
the original signed bytes remain valid. Confirmation never automatically removes
these records; retain them until their signed bytes can no longer be broadcast.

The [Core runner](../regtest-hd/recovery.js) independently exercises BIP-44 and
BIP-84. With a gap of three, it confirms a payment at receiving index two, then
allocates through index five and funds index five from a different mature input.
It invalidates the anchor's block, replaces the anchor transaction with a
conflicting payment, and mines the independent index-five payment on the new
canonical chain. It verifies the old block is orphaned, the anchor output is
absent, and the surviving output contains 50,000 satoshis.

On that fork, the latest state recovers 50,000 satoshis, an empty store with gap
three reports zero, and an empty store with gap six discovers 50,000 satoshis.
Core then accepts and mines a recovery spend using the restored state. These
checks passed with Bitcoin Core 29.0. The test adapter is intentionally forward
only; a fresh client rebuilds its canonical index after the fork, modeling a
recovery restart rather than claiming live reorg support for that adapter.

## Limits that recovery cannot remove

A finite address scan cannot prove that no funds exist beyond its checked range.
For any finite unused prefix, a wallet with a payment farther out looks identical
within that prefix. A reorg can remove the historical anchor that previously
made later address allocation satisfy the gap policy. Increasing a bound can
recover a known case; it cannot establish completeness across arbitrary unknown
past allocations.

A seed and canonical history also cannot reveal an unbroadcast signed
transaction held elsewhere. Its reservation, intended recipient and previous
address exposure are off-chain information. An empty restored store must not be
treated as proof that no such transaction exists. A stale metadata snapshot has
the same limitation for changes made after the snapshot.

The state adapter must preserve atomic durable revisions across every writer.
The test file store verifies persistence across manager recreation and serialized
CAS within one process. It does not establish production cross-process locking,
fsync, backup atomicity or power-loss durability.

## Procedure supported by the current API

1. Stop all writers for the account, including overlapping legacy leaf accounts.
   Identify the correct seed/signer, network, BIP and relative account root using
   a previously recorded primary address. Do not infer identity from an empty
   balance.
2. Restore the latest complete metadata snapshot into a dedicated store with no
   active writer. Preserve reservations and monotonically increasing indices;
   never replace a newer live revision with an older backup. Keep the original
   discovery settings and a budget large enough to cover issued indices plus
   the terminating unused gap.
3. Read balances, history and receipts against a provider reflecting the
   canonical chain. Saved allocation indices keep earlier scan gaps from
   terminating discovery before already-issued addresses.
4. If metadata is missing, use known issued-address bounds or application records
   to choose an explicit enlarged scan. Only perform read operations while
   recovery is unresolved. For an otherwise empty prefix through index `H`, a
   gap of at least `H + 1` and a budget of at least `H + gapLimit + 1` cover that
   address and its terminating gap. The current gap cap is 1,000; this is not a
   general arbitrary-range recovery interface.
5. Keep the enlarged settings with this recovery view. Reads do not write
   reconstructed high-water marks: switching back to the original smaller gap
   with the same empty store can hide the recovered payment again. Enlarging the
   configured gap also enlarges its future allocation allowance, so a temporary
   recovery scan should not silently become the normal sending account.
6. Reconcile outstanding signed transaction records and reservations before
   resuming writes. If those records cannot be recovered, the software cannot
   certify the absence of conflicting signed bytes. Do not automatically release
   reservations or broadcast a replacement merely because a provider currently
   sees no transaction. Any fund-moving recovery action requires a deliberate
   transaction decision by the account owner.

## Smallest future recovery interface

No production recovery API is added by this validation work. A separate bounded
scan accepting explicit receiving/change end indices would avoid changing the
normal gap/allocation policy. It should return the exact checked ranges,
canonical-chain reference and observed funds without exposing a signing account,
allocating addresses, or declaring the whole wallet recovered.

If persistent recovery is later needed, a separate explicit operation could
atomically record monotonic discovery floors under the verified account identity.
Discovery floors should remain distinct from issued-address counters. Such an
operation must preserve existing reservations and must not infer that missing
reservation records are empty. Importing known signed transactions or enabling
writes after metadata loss is a separate decision. That design requires its own
schema, concurrency and crash-recovery tests before implementation.
