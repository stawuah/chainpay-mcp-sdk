# Frontend regression checks

Run commands in this guide from `frontend/`.

Run the ordinary suite with `npm test`, and TypeScript/Vite checks with `npm run build`.

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
