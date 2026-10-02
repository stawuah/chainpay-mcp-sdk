# Combined release review — 2 October 2026

The original feature heads must not be deployed independently with Convex.
PR #24 carries the integrated release and fixes. Crossmint software is included
but remains disabled pending provider acceptance. Existing Render/Neon data has
not been cut over. Use the [operator handoff](../guides/vercel-convex-handoff.md).

## Reviewed revisions and disposition

The upstream baseline was `3c0f699f05127a6e2633bc5f523110b9e86f3789`.
Independent correctness, edge-case, verification-gap, and acceptance reviews
covered the feature diffs and their combined behavior. Findings were checked
against callers and existing protections before patching.

| PR | Original reviewed head | Disposition |
| --- | --- | --- |
| #19 | `8cb6edc` | Included with #20 and atomic-order/recovery corrections; server enable flag remains off. Current merge head `4209460` includes #20 with identical source to its reviewed tip. |
| #20 | `3f05517` | Merged into #19 during this review. Its fixes remain necessary; the remaining concurrency gap is fixed in #24. |
| #21 | `971cc26` | Included with actual approval-guard/receipt browser tests and completed gated continuation. |
| #22 | `8dd47fb` | Assets checked; independent of runtime. Crossmint “live” card remains held. |
| #23 | `c9f9663` | Program/layout and six local settlement tests pass. Deploy readers before any program upgrade. |
| #24 | `7eb5a33` | Expanded to the combined release: storage parity, canonical migrations, Git-linked config, checks, and this handoff. |
| #25 | `b6f869b` | Included; new receipt/policy records now persist and round-trip through Convex. |
| #26 | `9b67d52` | Included; public/owner receipt browser tests pass. |
| #27 | `f573c90` | Included with invoice mismatch, public acceptance, expiry and network fixes; original feature branch receives the focused frontend fix. |
| #28 | `9f5ac33` | New revert opened during review. Do not include: it removes #20's SQL bind correction, connector scope routing, duplicate-order guard, and transaction decoding fixes. No reason beyond “Reverts #20” was supplied. Owner decision remains open. |

Prefer merging the completed #24 with a merge commit, retaining its feature
ancestry. #22 can also land independently. The reviewed release excludes #28;
merging that revert afterward would reintroduce defects. No PR was merged or
closed by the review agent.

## Confirmed findings and corrections

| Severity | Finding | Correction / evidence |
| --- | --- | --- |
| High | Receipt/request/Crossmint branches lacked Convex storage variants and new-table migration coverage. | Implemented all transport/dispatcher operations, indexes, 13-table import/export and first-write-wins records; Rust compilation and Convex tests. |
| High | Two different SQL migrations used version 0009. | Canonical 0009–0012 sequence and checksum preflight. Alternate histories fail explicitly; no live history edits. |
| High | Concurrent Crossmint requests could both pass a lookup before payment. | Payment intent reservation precedes an atomic owner/order claim. Failed/uncertain operations retain the original key. PostgreSQL and memory concurrency tests. |
| High | MCP-only provider validation could be bypassed through direct relay calls. | Short-lived HMAC preparation binds verified owner, mandate, agent, order, invoice and exact terms; relay checks before fresh reservation/signing. |
| Medium | Caller-supplied phase/proof could impersonate provider evidence. | Axum fetches the fixed staging provider itself; supplied evidence is ignored. Settlement remains separate from fulfillment. |
| Medium | Pending Crossmint results could prompt another wallet signature. | Persist original operation and signed bytes; check existing operations before signing and use status-only continuation after reload. |
| Medium | Invoice amount/mint mismatches could still produce “Matched”; public proposals could look owner-accepted. | “Invoice differs” and “Acceptance unverified” propagate to cards and CSV. |
| Medium | Request deadline/network could be checked too early or only after creation. | Fail closed on unavailable slot; recheck signature, active cluster and expiry before preview and immediately before signing. |
| Medium | Approval-to-request linking lacked rendered regression coverage. | Browser fixture executes real Dashboard continuation, successful link and failed-link retry without another signature/submission. |
| Medium | Convex receipt lookup selected an older failed attempt. | Descending update order for payment lookup; seller attestation keeps its intentional earliest-publication order. |
| Medium | Legacy connector indexes could silently hide history or prior orders. | Both lookup paths fail visibly until a bounded maintenance backfill completes. |
| Medium | Legacy exports and imported microsecond ordering differed from PostgreSQL. | Canonical connector defaults and original timestamp checks; actual CLI round-trip tests cover old 0008 and current schema. |
| Medium | Migration tests did not execute restore/import commands. | Real disposable PostgreSQL plus a TLS gateway backed by convex-test verifies interrupted committed imports, repeat import, exact hashes, empty-target enforcement and transactional rollback. |
| Medium | Hosted builds could fall back to review URLs or mix RPC/agent endpoints. | Required environment configuration and paired-URL checks; operator verifies the actual database and three service identities. |

The integration also retains the earlier reviewed fixes for malformed Host
handling, compute-prefix relay validation, unknown/prepared-operation recovery,
merchant-body timeouts, Crossmint proof isolation, and Playwright's dependency
update. These were revalidated in the combined tests. Overlapping reviewer
findings were grouped by root cause; no confirmed finding was silently dropped.
The reviewers did not invent findings to meet a numerical quota.

## Verification

| Check | Result |
| --- | --- |
| Node 24 workspace typechecks / frontend production build | Passed |
| SDK / MCP / demo merchant / frontend unit tests | 91 / 98 / 27 / 201 passed |
| Convex storage regressions | 18 passed |
| Migration helper tests / release-environment guards | 2 / 2 passed |
| CLI migration integration | Passed: 13 populated tables, 105 payments, maximum-u64 values, exact round trips, interrupted/repeated import and rollback; legacy 0008 also verified |
| Rust workspace | 116 backend + 12 program/layout passed; 5 database tests separately passed on disposable PostgreSQL |
| SBF build / local settlement | Passed; all 6 settlement fixtures passed |
| Native Git-linked Rust relay package | Locked Cargo check passed |
| Rendered browser suites | Public verification, owner receipts/export, permission requests/link retry, Crossmint flag off at 1440px and on at 390px passed |
| Convex cloud compilation | Pushed only to isolated `dev/release-review-20261002`, `neighborly-starfish-738`; seven-day expiry |
| Dependency audit | Frontend zero; workspace retains 3 high and 6 moderate transitive entries, documented in dependency-advisories.md |
| Social kit | 54 JPEG assets plus 6 contact sheets readable; 8 silent H.264 clips approximately 5 seconds; overview inspected; no generator/API run |

The GitHub `Release checks` workflow adds reproducible checks without deployment
secrets. Hosted CI status is reported by GitHub after push, not inferred from
these local results. Local browser fixtures use inert bytes and intercepted
service calls. No real wallet/payment or provider order mutation was exercised.

## Remaining operator gates

- Kwasi grants the Git integration access and approves the combined PR; Dre sets
  native project roots, outside-root inclusion, Node 24, branch-specific URLs,
  and production/preview credentials. Native cloud builds with those account
  settings still require acceptance; the existing sites were not replaced.
- Deploy the current Convex schema before dependent builds. Do not route users
  until the source export, reconciliation and cutover checklist succeeds.
- Crossmint requires both server credentials and separately approved proof that
  its provider recognizes a ChainPay inner transfer and the correct payer/order.
  Only strict Devnet USDC preparation is supported; do not enable other tokens
  or discard additional provider instructions.
- Program upgrade, managed signer/provider configuration, and a fresh Devnet
  settlement are distinct operator actions. No mainnet transition is included.
- Preserve the documented transitive dependency risks, Rust runtime beta status,
  bounded scans/row sizes, and existing frontend chunk-size warning. These do
  not constitute zero-risk or live-payment acceptance.
