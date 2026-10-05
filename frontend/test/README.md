# Frontend regression checks

Run commands in this guide from `frontend/`.

Run the ordinary suite with `npm test`, and TypeScript/Vite checks with `npm run build`.

## Crossmint request and receipt browser check

Run `node test/crossmint-inbox.browser.mjs` with Playwright and Google Chrome
installed. This runner starts and closes its own local Vite servers, testing both
values of `VITE_CHAINPAY_CROSSMINT`; no separately running dev server is needed.
It exercises the real dashboard at desktop and 390px widths with keyboard request
expansion. Matching requests retain their approval control; mismatched, closed,
and already-paid requests do not, even when their stored stage still requests
approval. Completed, waiting, and refunded seller reports reach the loaded receipt
only with the flag enabled, preserving the exact payment and Allowed/Paid stamps.

External requests and local API/RPC proxy routes are blocked. The dashboard
harness supplies inert account reads and no signing wallet. These checks prove
rendering and approval gating, not live Crossmint fulfillment or settlement.

## Payment submission browser check

With the frontend dev server on port 5189, run
`node test/payment-submission.browser.mjs`. It uses the actual dashboard and
submission handler with fake account reads, an inert wallet and intercepted
service responses. It covers the legacy JSON-RPC error after approval, immediate
error display, retained recovery bytes after a 404, and recovery restoring the
original receipt link without another approval. Desktop and mobile screenshots
are saved under `/tmp/chainpay-payment-error-*.png`. These fixtures are not live
payment evidence. `mcp-submission.test.mjs` covers other submission error formats
and confirmed responses in the ordinary suite.

## Permission detail browser fixture

Start `npm run dev -- --host 127.0.0.1 --port 5189`. With Playwright and Google Chrome
installed, run `npm run test:permission-browser`. If Playwright is installed outside
this package, set `PLAYWRIGHT_MODULE` to that installation's absolute `index.mjs` path.
The browser runner is optional and is not included in the Node unit suite.

The runner mounts the actual `MandatesPanel`, Astryx theme and Router with local
records. It blocks external requests and stubs the font stylesheet. It checks owner
scoping, exact base units, nested keyboard actions, Escape/focus, revoke review,
panel/full-page Back, search/scroll retention, loading/error states and wallet changes.
Mobile screenshots are written to `/tmp/chainpay-permission-panel-*.png`.

`fixtures/permission-details.html` and `.tsx` are test-only Vite entries; they are
not imported by production and are not included in its build. The fixture cannot
sign or submit transactions. Its records and screenshots are regression evidence,
not payment acceptance. Local HMR websocket restrictions do not affect these checks.

## Status page browser check

With the frontend dev server on port 5189, run `npm run test:status-browser`. It opens
the real `/status` route with a mocked `/status/v1` feed and blocks every other external
request. It checks that stale checks read "Unknown" on each row (not "Operational"), that a
day the prober barely ran is a "Partial data" bar, and that at 390/320px a tapped bar keeps
its tooltip on-screen until a tap elsewhere, with no horizontal scroll. Screenshots go to
`/tmp/chainpay-status-*.png` (`CHAINPAY_STATUS_SHOTS` overrides the prefix).
`status-page.test.mjs` covers the same states in the ordinary suite with jsdom.

## Landing story browser check

With the frontend dev server on port 5189, run `node test/landing.browser.mjs`
from `frontend/`. It uses the same optional `PLAYWRIGHT_MODULE` override as the
permission check and installed Chrome. `CHAINPAY_PREVIEW_URL` overrides the URL.
The check covers desktop and 390/320px layouts, receipt anchor navigation,
reduced-motion teardown, menu Escape, CTA contrast, and dashboard navigation.
Screenshots are written to `/tmp/chainpay-landing-*.png`. External requests are
blocked; no wallet or payment is used.

`node test/landing-motion.browser.mjs` additionally checks the desktop pinned
sequence in both scroll directions, all four visible states, card viewport
bounds, button text contrast (normal/hover/focus), and reduced-motion teardown.
It uses the same Playwright override and local server on port 5189.

## Owner onboarding browser check

With a frontend dev server on port 5173 and Google Chrome installed, run
`npm run test:owner-onboarding-browser`. Set `CHAINPAY_PREVIEW_URL` if you use a
different port. This runner imports the package-local Playwright installation.

It mounts the actual owner controller and routes with a deliberately fake wallet,
blocks external services, and checks wallet discovery, connection without login,
explicit message-signing retries, and navigation to mandate review. It rejects
financial signing. Screenshots are fixture rendering evidence only.

## Receipt limits, Order match and export browser checks

With the frontend dev server on port 5189, `npm run test:verify-public-browser`
also covers limits at payment from an on-chain snapshot and from a relay
observation that already counts later payments, and an audit link
(`/verify/<pda>#purchase=…`) that verifies or is rejected without showing any
of its content. `npm run test:receipts-owner-browser` mounts the dashboard
harness with `?tab=receipts&receipts`: one original receipt and one 371-byte
receipt with a policy snapshot, plus a stand-in for the owner's relay session
that returns the fixture's seller-signed invoice
(`fixtures/receipt-purchase.json`). It checks the owner Order match, Share with
details, Export CSV (a real browser download), 44px controls and no horizontal
scroll at 390 and 320px. External requests are blocked; these are fixtures, not
payment evidence.

## Permission request browser check

With the frontend dev server on port 5189 (or `CHAINPAY_PREVIEW_URL`), run
`npm run test:permission-request-browser`. It uses the dashboard harness with
`?permission=vendor|grantee|expired|tampered` (a fixture `#req=` link from
`fixtures/mandate-request.json`, deterministic keys) and `?orders` (an accepted
purchase order and budget request behind a stand-in relay). It checks the
request card, blocked links, Decline, the builder prefill (budget request:
**Requester's agent signs** fixed), "(requested X)" review rows and the
expected payee, the **Matched** receipt, Share with details carrying the
order, the CSV PO number and Order match columns, and the permission
Statement, at 1440 and 390. Screenshots go to `CHAINPAY_SHOTS_DIR` (default
`/tmp`) as `pr4-*.png`. The `fixture-approval` mode exercises the real
post-wallet continuation using invalid fixture bytes and intercepts every
service request in memory, with no network fallback. It verifies successful
linking, failed-link retry without a second signature/submission, and expiry
between preview and approval. No real transaction is signed or submitted.

The unit suite also checks unavailable-slot refusal, network mismatch,
acceptance deadlines, public proposals displaying **Acceptance unverified**,
and invoice amount/token mismatches displaying **Invoice differs** in the
receipt model and CSV.

## Community robot

With `VITE_CHAINPAY_SHARED_PET=on`, start the development server on port 5191
(`PET_BROWSER_BASE` overrides its URL), then run
`npm run test:community-pet-browser`. The mocked API suite covers 390/768/1440px,
200% zoom, keyboard care, WebGL fallback, reduced motion, requested photos,
uncertain command replay, hidden-tab polling, concurrent browser sessions,
discoveries, repeat reactions, and scrapbook pagination during refreshes. The regular unit suite also
checks shared client state and legacy cross-tab serialization. See the
[preview guide](../../docs/guides/community-pet.md) for flags and evidence limits.

## Receipt honesty (audit 2026-10-05, R1)

`verify-entry-retry.test.mjs` covers pasted `/verify/<pda>` links (parsed
locally, never fetched) and the retry generation guard: a retry for receipt A
that answers after the page moved to B never replaces B, in `VerifyPage`,
`LoadedReceiptCard` and the shared loader in `receipts/load.ts`.
`embed-overview.test.mjs` covers the embed's error recovery and that only
`confirmed` payments show as receipts. `support-page.test.mjs` covers `/support`
closed and open-on-Devnet copy. `cards.test.mjs` covers the `/verify/card` paste
field, retry and verdict-only notes, and the cards-off link. The harnesses add
`card-verify.html?state=rpc_error|no_commitment` and
`dashboard-harness.html?tab=cards&cards=off` for screenshots.
