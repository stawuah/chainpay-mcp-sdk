# Release manifest

A release manifest records one release: what was deployed and where the
evidence for each feature lives. Make one for every production or preview
release you plan to show to anyone. Copy the template below into the release's
PR, issue or tag notes, fill it in, and link it from
[implementation status](implementation-status.md).

**Rules**

- **A passing fixture or health endpoint never substitutes for evidence.**
  Tests, harness screenshots and `healthz` show the code runs. Evidence is a
  real run on this release: a signature, a receipt address, a provider object
  ID, a URL a stranger can open, with timestamps.
- **No secrets.** Record names, IDs, public keys and origins. Never record key
  values, deploy keys, database URLs with credentials, webhook secrets or card
  numbers. Credentials stay in the provider secret stores.
- **Flags record what was read back, not what was intended.** If you cannot
  read a value (Vercel marks it sensitive), write "set, unread" or "unverified".
- **A gate with no evidence link is not passed.** Write "not run" or "failed"
  and leave the feature off or labeled Coming soon.
- **Turn on one optional feature at a time**, each with its own manifest update.
  Roll back with the UI/new-intent flags first. Never create a new payment to get
  out of an uncertain one.
- Writing the manifest does not authorize signing, paying, deploying or
  changing a flag. Each of those needs the owner's explicit approval.

## Template

```markdown
# Release <name>: <YYYY-MM-DD>

Prepared by: <name> · Reviewed by: <name>

## Source
- Repository: stawuah/chainpay-mcp-sdk
- Source SHA (full 40 chars): <sha>
- Release checks run: <link to the green "Release checks" run for this SHA>
- Deploy run: <link to the "Deploy to Vercel" run> · Release ID: gh-<run_id>-<attempt>

## Deployments
| Component | Project / deployment | ID or URL | Deployed SHA | Read back how |
| --- | --- | --- | --- | --- |
| Web (chainpay-web) | prj_Dj8Zwe3XCNYWkBkkMYA8uyaeVumF | <Vercel deployment ID + immutable URL> | <sha> | <deploy log / Vercel meta githubCommitSha> |
| Relay (chainpay-relay) | prj_IkQCAoCokR21UJ6BsfvBoQhnSL0p | <…> | <sha> | <…> |
| MCP (chainpay-mcp) | prj_Dx2WJT5AjTrOxaOe2cj1KMeIBCEc | <…> | <sha> | <…> |
| Convex functions | <deployment name> | <deploy log line> | <sha> | <…> |

## Database identity
- Store: convex | postgres
- Convex deployment name: <e.g. notable-bee-447> (prod/dev) · team/project: <…>
- Release group (scripts/production-release.json `group`): <…>
- Schema/migration level: <Convex schema at SHA / Postgres migrations through 00NN>
- Data origin: <fresh / migrated from …, with the reconciliation record>

## Chain
- Cluster: devnet
- Genesis hash read back: <…>
- ChainPay program: 3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4 · program-data last deploy slot: <…> · upgrade authority: <pubkey>
- Receipt layout produced by that program: 282-byte (no snapshot) | 371-byte (snapshot)
- card_policy program: <id, or "not used">
- Support splitter program / vault / vault USDC account: <ids, or "not deployed">
- Mints accepted for this release: <mint addresses>

## Public origins
- Web: <…> · Relay: <…> · MCP: <…> · Convex site: <…>
- Matches scripts/production-release.json: yes/no

## Flags (value read back, or "set, unread" / "unset")
| Flag | Where | Value |
| --- | --- | --- |
| CHAINPAY_CROSSMINT_ENABLED | relay, MCP | |
| VITE_CHAINPAY_CROSSMINT | web build | |
| CARDS_CONNECTOR_ENABLED | relay | |
| CARDS_ISSUER_WRITES_ENABLED | relay | |
| CARDS_CHECKOUT_ENABLED | relay | |
| CARDS_NEW_ACTIVATION_ENABLED (#52) | relay | |
| LITHIC_API_URL (must be sandbox) | relay | |
| CARDS_PARTNER_TOKEN_ACCOUNT / VITE_CHAINPAY_CARD_PARTNER_TOKEN_ACCOUNT | relay / web | |
| VITE_CHAINPAY_CARD_POLICY_PROGRAM_ID, VITE_CHAINPAY_CARD_ISSUER_ENV | web build | |
| SUPPORT_LIVE, SUPPORT_CLUSTER, SUPPORT_PROGRAM_ID, SUPPORT_VAULT, SUPPORT_VAULT_USDC | Convex | |
| VITE_SUPPORT_LIVE, VITE_SUPPORT_CLUSTER, VITE_SUPPORT_PROGRAM_ID, VITE_SUPPORT_TRACKER_URL, VITE_SUPPORT_RECIPIENT_A/B (#56) | web build | |
| OWNER_WEBHOOKS_ENABLED (#57), OWNER_WEBHOOKS_SECRET_KID | relay | |
| OWNER_WEBHOOKS_DISPATCH_URL (#57) | GitHub repo variable | |
| CHAINPAY_X402_ALLOWED_ORIGINS, CHAINPAY_X402_RECEIPT_MERCHANTS | relay, MCP | |
| CHAINPAY_SHARED_PET / VITE_CHAINPAY_SHARED_PET | relay + Convex / web | |
| Managed signing provider (healthz `managed_signing`) | relay | |

## Scheduled jobs
| Job | Schedule | Target URL | Last successful run (link) |
| --- | --- | --- | --- |
| Cards reconcile | | | |
| Support indexer (Convex cron) | | | |
| Owner webhooks dispatch (#57) | | | |

## Evidence per gate
| Gate | Result | Evidence links | Notes |
| --- | --- | --- | --- |
| Receipt render | | | |
| Core payment | | | |
| Custom x402 | | | |
| Cards | | | |
| Support rehearsal | | | |
| Crossmint | | | |
| Owner webhooks | | | |

## Rollback
- Previous release manifest: <link>
- Flags to flip first: <…>
- In-flight payments / refunds / activations at release time: <count + where they are tracked>
```

## Acceptance gates

These come from the 2026-10-05 audit remediation plan. Check a box only when
the evidence column of the manifest links the proof.

### Receipt render (audit fixes A1–A3, A5, A6, A8, A10; [#53](https://github.com/stawuah/chainpay-mcp-sdk/pull/53))

- [ ] Without a wallet, the public site opens `/verify/<demo receipt>` from the landing **See a receipt** and shows the receipt card. Exact amount and token match the chain.
- [ ] An old receipt with no payment-time snapshot never says the payment was within the limit or paid before expiry. Current limits are labeled as current.
- [ ] A snapshot receipt (371 bytes, only after the program upgrade) shows only facts the snapshot supports. "Paid before expiry" appears only when the stored expiry slot is after the payment slot.
- [ ] The illustrative sample receipt never implies a live verification.
- [ ] A raw address and a full `/verify/<pda>` link resolve to the same card. Malformed links fail with a clear error. The pasted origin is never fetched.
- [ ] Retrying receipt A and then opening receipt B: the late A result never replaces B or its amount.
- [ ] `/verify/card` with no link offers a paste field. An RPC error offers a retry. Mismatch, superseded and wrong-card results never say the values match.
- [ ] Embed overview: a load error restores the address field and a retry. Unsettled operations never appear as spending.

### Core payment ([implementation status](implementation-status.md), [acceptance runbook](local-e2e-testing.md))

Use one controlled owner and one reviewed Devnet mint. Human approval comes
first. Delegated Privy signing needs its own proof.

- [ ] Approve limits, request a permitted amount, sign, wait for finality. The receipt verifies in the owner UI and in a public browser.
- [ ] Over-limit, paused, revoked and duplicate requests are refused with no extra transfer.
- [ ] An ambiguous operation is recovered under the original approval, without a second payment.
- [ ] The payment record reads back from the release's database (store identity above).
- [ ] Recorded: release ID, timestamps, exact amounts (base units and decimals), signatures, receipt addresses.

### Custom x402 ([x402 acceptance checklist](../guides/acceptance-x402-mcp.md))

- [ ] 402 challenge → mandate payment → finalized receipt proof → HTTP 200 resource.
- [ ] A replay of the same request does not pay twice. An unavailable merchant after settlement keeps the original receipt and does not pay again.
- [ ] Standard v2-shaped challenges settle only for origins in `CHAINPAY_X402_RECEIPT_MERCHANTS`. Generic facilitator or sponsor compatibility is not claimed.

### Cards ([#52](https://github.com/stawuah/chainpay-mcp-sdk/pull/52))

- [ ] Activation reports "on" only when the issuer shows the card open, the limits are mirrored, and the public `CardCommitment` reads back for that policy version.
- [ ] Partial states (proof pending, limits not copied, issuer pending) show what actually happened. "Paused" appears only when the issuer reads back paused.
- [ ] Period end, close and discharge keep their checkpoint state, and reconcile repairs it. Cite the scheduled reconcile run that reached this deployment.
- [ ] With `CARDS_NEW_ACTIVATION_ENABLED=false`, direct API calls to prepare and activate are refused. Reads, pause, statements and repayment still work.
- [ ] Transparent repayment produces a ChainPay receipt. Private repayment keeps its authorizer-attested label. Simulated credit is labeled simulated.

### Support rehearsal ([#56](https://github.com/stawuah/chainpay-mcp-sdk/pull/56), `programs/support-splitter/DEPLOY.md`)

Devnet test tokens only. No mainnet deploy, no authority removal, no swaps.

- [ ] Both partners' Devnet recipient addresses were set up through the signed process and verified.
- [ ] The splitter build identity and the authorized Devnet deployment are recorded. Dual-signature initialization signature is recorded.
- [ ] Rehearsed: contribution → finalized index → allocate → each recipient claims their own share. Exact amounts and rounding checked.
- [ ] Duplicate signature indexing, repeat payout, wrong-destination refusal, and one side failing without blocking the other were all tested.
- [ ] On-chain balances and indexer readback match. Network labels say Devnet. Mobile flow checked.
- [ ] The page opened only after program, tracker and UI agreed.

### Crossmint ([#55](https://github.com/stawuah/chainpay-mcp-sdk/pull/55))

- [ ] Staging project, Orders API permissions and the server-only auth secret are confirmed by name only.
- [ ] One operator-created staging order is quoted. The sanitized order shows chain, mint, payment recipient, delivery recipient, payer, exact amount and expiry.
- [ ] Crossmint credits that order when it is paid by the mandate-controlled transfer. No plain-transfer fallback, no agent-funded wallet.
- [ ] The finalized ChainPay receipt matches Crossmint's payment state. Delivery state is tracked separately. A refund or failed delivery stays visible.
- [ ] Refresh, quote expiry, payer mismatch, amount mismatch, replay and ambiguous responses resume the original operation. None buys again.
- [ ] Only after all of the above: `CHAINPAY_CROSSMINT_ENABLED` and `VITE_CHAINPAY_CROSSMINT` are on for this environment, and the Coming soon copy is updated.

### Owner webhooks ([#57](https://github.com/stawuah/chainpay-mcp-sdk/pull/57))

- [ ] One deployed Devnet `payment.receipt_ready` event reaches a controlled HTTPS endpoint and verifies with the documented signature check.
- [ ] Endpoint answers 2xx, 500, 429, and a timeout after storing the event. Retries reuse the event ID. A dedupe-by-ID receiver processes it once.
- [ ] A dispatcher crash or restart loses no event. Concurrent dispatchers never deliver the same row twice.
- [ ] An invalid signature or stale timestamp is rejected. Another owner's endpoints are not reachable. Unsafe destinations are blocked.
- [ ] A receiver outage does not delay settlement or create a new payment.
- [ ] Cite the scheduled dispatch run that reached this deployment.

## Baseline: master `c936067` (partial, 2026-10-05)

This was filled from read-only public checks. It is not a complete manifest:
deploy-account details and every evidence gate are still open.

- Source SHA: `c936067af6c8c34d33c65a06f5f0119a405178f6`.
- Deploy run: [37219312021](https://github.com/stawuah/chainpay-mcp-sdk/actions/runs/37219312021) (2026-10-04, `workflow_dispatch`, all jobs succeeded) · release ID `gh-37219312021-1`.
- Vercel deployments from that run (inspect IDs): web `8eSWcRK4aivDKbT8t9mYp1zhJK7n`, relay `FqdsSrf8QuqeDZug8zYnEg9sxc9y`, MCP `8uLjQwUDuUgmHXuiyukxbnxMGTVN`. Whether these still serve the aliases is unverified.
- Database: Convex production `notable-bee-447`, group `chainpay-production-v1`.
- Chain: Devnet. ChainPay program `3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4`, program data last deployed at slot `484104138` (2026-08-15). It writes 282-byte receipts: 26 exist, and 0 of 371 bytes. `card_policy` `H3aetJdQXG8EeJSCHZrpQa8iKHBw8e1p9fSPjTUsB93n` is deployed. The support splitter is not deployed.
- Public origins: as in [`scripts/production-release.json`](../../scripts/production-release.json).
- Flags: unread. Two values were observed from outside: the cards connector answers on the relay, and `/pet` is off.
- Evidence gates: none passed on this release yet.
