# Owner dashboard redesign · 16 September 2026

## Review contract

First implement an isolated, high-fidelity browser preview of the shell, Overview, wallet entry/menu, and guided permission setup. Use labeled fixtures and no wallet, RPC, backend, or transaction imports. Review this direction with Dre before migrating the live dashboard. Remaining sidebar destinations are identified as later review surfaces rather than pretending to be implemented.

Run `npm --prefix frontend run dev -- --host 127.0.0.1 --port 5189`, then open `/test/fixtures/dashboard-redesign.html`.

## Agreed experience

- Owner-first, calm, spacious, blue/white, one Inter family; useful visuals instead of explanatory filler.
- Overview prioritizes attention, then spending, agent status and recent activity.
- Main navigation: Overview, Agents, Spending permissions, Requests, Payments; Settings at bottom.
- Agents manages connections and access. Requests is an action inbox with a secondary composer. Payments holds history and receipt details; New payment is secondary, with batch inside that flow.
- Settings includes wallet/account actions and Advanced developer/diagnostic/protocol surfaces.
- Wallet entry: choose, connect, sign in, enter workspace. Sign-in grants no spending authority.
- Permissions: approval method, limits, review/approval. Human mode default; automated spending explicitly chosen and availability checked.
- Agent pairing requires an owned mandate today: collect name, select/create permission, then issue scoped credentials. Configured is different from connected.
- Background read-only checks; show prerequisites only when they require action. Preserve independent wallet approvals for account creation and enrollment.

## Visual contract

Inter 400/500/600; 28px page headings, 20px section headings, 16px body/inputs, 14px labels and table content, 12px metadata. Tabular financial numerals. Lucide icons, 20px/1.75 stroke, visible navigation labels. Four-pixel spacing rhythm; 24–32px desktop gutters; 44px controls; 8–12px radii. Neutral canvas, white content, blue reserved for active/action states. Accessible state colors. 150–200ms transitions with reduced-motion alternatives. Use Astryx buttons, fields and dialogs with a scoped preview theme.

## Production migration

Extract dashboard pages and shared components, retaining SDK/settlement handlers. Add frontend view selectors over existing state; join activity only by known IDs. Preserve separate token totals and missing-data states. Keep `/app/assistant`, `/app/receipts`, `/app/receipts/:pda`, `/app/connect-mcp`, tools and protocol links compatible when introducing Requests/Payments/Advanced navigation. Shared receipt card continues to serve public wallet-free verification. Source service artwork from official x402/pay.sh properties at integration time.

No new backend, migrations, invented names/analytics, or financial actions. Planning decisions are recorded outside this product repository through the BMAD memlog.

## First review delivery

Implemented in `frontend/src/design-preview/`, loaded only by the test fixture entry. The production dashboard does not import the preview. The fixture includes six selectable states, an interactive permission list, three-step permission creation, exact six-decimal sample amount validation, prerequisite preparation, wallet selection/sign-in simulation, contextual record dialogs, and responsive navigation. Sample agent names and transactions are confined to this preview.

Review Overview first, then New permission. Use the Preview state selector for a new workspace, loading/error states, or a missing token-account prerequisite. The wallet control demonstrates provider selection and sign-in. Agents, Requests, Payments, and Settings navigation explain that their full layouts belong to the next review phase.

Validation on 2026-09-16:

- `npm --prefix frontend run build`: passed (existing large-chunk warning).
- `npm --prefix frontend test`: 85 passed.
- `npm --prefix frontend run test:dashboard-preview`: passed. Exercises input precision/limits, prerequisite blocking and recovery, wallet dialogs, item-specific state, Escape/focus restoration, reduced motion, no document overflow at 390/768/1440px, and CSS 200% scaling. Browser page errors and non-local/financial requests are asserted absent.
- Screenshots captured at `/tmp/chainpay-redesign-review/`; desktop Overview, permission method/limits, mobile Overview/method, and enlarged layout visually inspected.

Dre approved the representative screens, then reviewed the live rollout and requested the refinements recorded below. The isolated preview remains available as a design reference.


## Live rollout and refinement · 17 September 2026

The approved direction is implemented in the live workspace. Navigation now has six owner destinations; legacy request, receipt, and advanced routes stay compatible. Wallet connection and explicit message sign-in precede workspace entry. Permission setup uses approval method, spending limits, and review, preserving separate account-creation, signer-enrollment, and transaction approvals.

Overview groups exact spending by token and shows official token marks for known mints, with a neutral fallback for other assets. Agents has one connection list. Requests uses attention/progress/completed/archived filters and an optional composer. Payments opens on receipt history, with manual and batch creation secondary. Receipt lookup offers address and permission/invoice modes, visible validation, consistent receipt styling, and share/open actions. Settings groups wallet/account, network, advanced diagnostics, and red disconnect/revoke controls. The sidebar toggle is centered on its edge.

Spending amount cards pair exact text fields with whole-token convenience sliders (quick ranges of 1–100 and 1–1,000 tokens). These ranges do not cap typed amounts. Slider positioning never mutates a typed decimal amount; validation and transaction building continue to use exact decimal strings and bigint base units. No slider movement signs or submits anything.

The initial x402 mark was verified against x402.org; the refinement uses the shield/wordmark supplied in the official x402 repository. Asset sources are recorded in `frontend/src/assets/brands/dashboard-sources.md`.

Validation: production build and 87 unit tests pass. Live browser checks cover six pages at 390/768/1440px, exact amount precision and review/edit retention, request draft retention, connection dialog, wallet menu, centered sidebar collapse, mobile navigation, reduced motion and 200% CSS scaling, populated receipt history/detail, lookup errors, and confirmation dialogs. Separate onboarding, permission-detail, navigation, record-detail style scoping, and public receipt checks passed. Browser data was isolated; no financial transaction was signed or submitted. Existing Astryx large-chunk warning remains. These checks do not certify a live settlement or external signer-provider availability.

Run `npm --prefix frontend run test:dashboard-owner` with Vite on port 5189. The production entry is `/app`; the read-only full dashboard fixture is `/test/fixtures/dashboard-harness.html?ready`, with `&tab=payments&receipts` for populated receipt review. Screenshots are saved under `/tmp/chainpay-owner-*.png`.
