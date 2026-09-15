# Declaration and package checks

```sh
npm ci
npm run build:types
npm run test:types
```

The strict consumer checks every generated declaration with `skipLibCheck: false`,
positive API calls, rejected argument shapes, private/protected visibility and
checks for accidental `any` types. The spend-plan fixture checks the wallet's
selected-input contract. The compiler regression first reproduces the
original declaration failure, then checks corrected emission and unchanged
installed compiler files.

TypeScript 5.9.3 drops some concrete implementations of inherited abstract members
when emitting declarations from JavaScript. `scripts/build-types.cjs` adds the
missing abstract-member condition to a temporary compiler copy. It verifies the
exact compiler version and both file hashes, fails on unknown content, and cleans
up the copy. It changes neither installed dependencies nor generated declarations
after emission. Reassess and remove the workaround when upgrading the compiler.
The existing declaration-only emit configuration is separate from the strict
consumer check.

For Bare 1.32.0, run:

```sh
npm run test:hd:bare
```

This gate uses the package exports and the unmodified `bare-node-runtime` bridge.
It checks both BIPs, independent derived addresses, real signatures, multiple
funding keys, change rotation, file-backed state, restoration, fees and history.
It uses the offline Bitcoin client and does not claim consensus or production
storage guarantees. Set `WDK_BARE_RESULT` to save a successful result.

The wallet retains descriptors 3.1.7 and requires bare-node-runtime 1.5.1 or later.
Bridge 1.5.0 advertised Node 20.0.0, below the descriptor package's Node >=20.19
requirement. Bridge 1.5.1 advertises Node 24.21.0. The gate records the actual
official bridge target and exercises the wallet's P2PKH/P2WPKH inputs; the Bitcoin
Core destination matrix is a separate check. Installed-package integrity must be
verified separately; the runtime version alone is not proof of unmodified code.

For distribution validation, pack the module and install the tarball in a fresh
consumer with strict npm engines and no overrides. Copy `tests/package` and the
`tests/hd/bitcoin-client.js` fixture into that consumer. Point its strict config at
both `consumer.mts` and the installed package's `types/**/*.d.ts`, then run the
unmodified TypeScript validator and Bare entry there. This ensures the installed
exports and declarations are exercised, not a source-directory shortcut.
