# ChainPay dependency matrix and residual advisories

Recorded 2026-09-15. This is a lockfile-maintenance disposition, not a
dependency security certification and not live settlement acceptance.
`npm audit fix --force` was not run; that path proposes Solana SDK
downgrades that PR-12 forbids.

## Tested matrix after PR-12 lock refresh

| Surface | Pin / resolved | Evidence 2026-09-15 |
|---|---|---|
| `qs` (workspace, Express / body-parser) | **6.15.3 → 6.16.0** exact pin on `@chainpay/demo-merchant` plus root `overrides` | Official patch for [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) (published 2026-08-29, reviewed 2026-09-02). `demo-merchant` query-parsing fixture plus merchant typecheck. |
| Frontend transitive `nanoid` (Vite / PostCSS) | **3.3.16 → 3.3.18** via frontend `overrides` | Compatible 3.x patch for [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) / CVE-2026-67213. Did not install Astryx; no `frontend/src` rewrite. Frontend typecheck and existing frontend tests. |
| `@solana/web3.js` | `^1.98.4` unchanged | Workspace / SDK / merchant consumers. No audit-force downgrade. |
| `@solana/spl-token` | `^0.4.15` unchanged | Pulls `@solana/buffer-layout-utils` → `bigint-buffer`. |
| Anchor program | **1.1.2 assessed, no upgrade** | Changelog 1.2.0 exists ([Anchor updates](https://www.anchor-lang.com/docs/updates/changelog): pausable mint helper, build flags, generated TS errors). None of those are required for current payment policy. Local 2026-09-15 `NO_DNA=1 cargo test -p chainpay --lib --test layout` already passed 8 policy/program and 2 layout/PDA tests with this pin beside PR-01 `solana-transaction` 4.2.0. Compiled SBF / LiteSVM / live program acceptance are still absent. |
| jayson (via `@solana/web3.js`) | 4.3.0 unchanged | Transitive `stream-json@1.9.1` and `uuid@8.3.2`. |

## qs consumer

Express 5 defaults `query parser` to Node `querystring` (`simple`). `qs`
is still the Express `extended` parser and the body-parser urlencoded
parser. body-parser calls `qs.parse` with `allowPrototypes` /
`arrayLimit` / `parameterLimit` and does **not** set `comma: true` or
`throwOnLimitExceeded: true`. The advisory path is therefore not the
merchant default, but 6.16.0 is the official in-range patch and is what
the lock now resolves.

The merchant payment path itself reads `X-PAYMENT` headers, not query
strings. The fixture covers ordinary query objects only.

## Residual advisories (retained)

Workspace `npm audit` after the `qs` bump reports **9** affected
package entries (3 high, 6 moderate), down from the implementation
baseline of 10. Frontend `npm audit` reports **0**. The remaining
workspace entries are `bigint-buffer` plus its Solana parents
(`@solana/buffer-layout-utils`, `@solana/spl-token`), `stream-json`
plus `jayson` / `@solana/web3.js` parents, jayson `uuid`, and two
`@solana/spl-token-*` nodes that inherit the web3/jayson finding.
These are not independently exploitable ChainPay payment bugs.
Reachability notes below are from source inspection of installed
packages on 2026-09-15. No attack scripts or vulnerable native calls
were executed. SDK and MCP tests printed bigint-buffer's local
"Failed to load bindings, pure JS will be used" fallback; that
observation does not prove every deployment path uses the JS fallback.

### bigint-buffer <= 1.1.5 — [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) (CVE-2025-3194)

- **Published / last advisory update:** 2025-04-04. Official patched
  release: none.
- **How it arrives:** `@solana/spl-token` → `@solana/buffer-layout-utils@0.3.0`
  → `bigint-buffer@1.1.5`.
- **Inspected use:** `buffer-layout-utils` decodes a fixed-length blob
  (`u64`/`u128`/`u192`/`u256`) then converts that copy. Native bindings
  fall back to pure JS when the N-API addon is missing.
- **Disposition:** Retained. No supported upstream patch. Community
  forks and untested overrides were not applied. Do not downgrade Solana
  packages to versions `npm audit fix --force` may suggest. Residual
  crash risk remains if a future call path feeds `toBigIntLE` an
  unexpected buffer; current decode wrapping does not prove every
  deployment path safe.

### stream-json 1.9.1 — [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) (CVE-2026-71429)

- **Published:** 2026-07-07; advisory updated 2026-09-03. Official
  patch is **3.5.0** (current latest 3.6.0). jayson 4.3.0 requests
  `stream-json@^1.9.1`; 1.9.1 is the last 1.x line.
- **Inspected use:** `jayson/lib/utils.js` imports
  `stream-json/streamers/StreamValues` and `stream-json/utils/Verifier`
  for JSON-RPC stream parse. The advisory names `pick` / `ignore` /
  `filter` / `replace` (quadratic path-string rebuild). The same
  advisory states streamers that use `asm.depth` are not that path.
- **Disposition:** Retained. A 1.x → 3.x override would be an untested
  major jump through jayson / `@solana/web3.js` and was not applied.
  Residual risk: other jayson or future web3 call paths that started
  using the named filters would be in-scope; the inspected consumer
  does not import those filters.

### uuid 8.3.2 (jayson) — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (CVE-2026-41907)

- **Published:** 2026-04-19. Official patches: 11.1.1 / 12.0.1 / 13.0.1
  (and later 14.x).
- **Inspected use:** jayson `lib/utils.js`, `lib/generateRequest.js`,
  and `lib/client/browser/index.js` call `uuid.v4()` with no
  caller-supplied output buffer. The advisory is a missing bounds check
  on `v3` / `v5` / `v6` when `buf` is provided.
- **Also present:** `rpc-websockets` already resolves `uuid@14.0.1`
  (outside the affected ranges).
- **Disposition:** Retained on the jayson 8.3.2 node. Forcing uuid 11+
  onto jayson would be an unsupported major override solely to clear an
  audit count. This specific consumer does not demonstrate the advisory
  API.

## What PR-12 did not do

- No Anchor 1.2.0 upgrade, program layout change, or program PR.
- No Solana SDK downgrade and no `npm audit fix --force`.
- No Astryx install (that remains PR-03 UI work). Frontend `nanoid` was
  patched here because it needed only `frontend/package.json` + lock.
- No live transactions, private keys, or deployment.

Local payment tests and typechecks are regression evidence only.
