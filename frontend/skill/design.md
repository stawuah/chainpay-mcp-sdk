---
name: chainpay-design-system
description: Current ChainPay Connection identity and React/Astryx UI conventions. Read before extending the frontend.
---

# ChainPay UI design guidance

Extend the implemented **Connection** identity: ChainPay blue, white surfaces,
Inter, and the existing Astryx components. The [brand guide](../src/brand/README.md)
and [theme source](../src/theme/chainpay-theme.ts) are the implementation references.

## Identity and typography

| Role | Current rule |
| --- | --- |
| Logo | Reuse `BrandLogo` or `BrandMark`; preserve the rounded-hook geometry |
| Brand colors | Blue `#0052ff`, ink `#14213d`, white surfaces |
| Body | Inter 400 with system fallback |
| Headings and wordmark | Inter 500 |
| Labels and technical values | Labels 600; JetBrains Mono for technical values |

Use [brand exports](../public/brand/) when a component cannot render the shared
React logo. Do not construct a substitute logo with text or CSS. The earlier
page-by-page proposal is [historical](../../docs/archive/dashboard-proposal.md).
It does not describe every current route or interaction.

## Component system

The runnable app is Vite and React with Astryx 0.6.1, its neutral theme, and
StyleX. Extend [ChainPayTheme](../src/theme/ChainPayTheme.tsx) and the existing
controls instead of introducing another UI system. Tailwind, shadcn/ui and Radix
were removed from this app deliberately; do not reintroduce any of them, and do
not add a second component library alongside Astryx.

Follow the actual import order in the app entry points. Theme and overrides
live in `frontend/src/theme/`; legacy token CSS remains in `frontend/skill/assets/`
because runtime components still import it. Moving this guide does not justify
moving or deleting those assets.

Keep financial record styles scoped to their components. A receipt or permission
panel stylesheet must not restyle every app input, heading, or button. The
current theme sets 44px small/medium controls and 24px container radii.

## Reading and interaction

- Lead with human-readable purpose, amount, and status. Put protocol identifiers
  in technical detail without hiding the complete value.
- Preserve exact amounts. Show verified decimals or clearly labeled base units;
  never truncate financial digits to fit a layout.
- Separate wallet connection, message sign-in, mandate approval, and payment
  approval. An earlier step never silently authorizes a later signature.
- Keep settled payment evidence separate from optional seller statements.
  Current mandate state is not a historical policy snapshot.
- Use real loading, empty, unavailable, rejected, and pending states. Do not fill
  empty dashboards with unmarked sample financial data.

## Exact words and exact numbers

These two are mechanical. A reviewer can grep for them, so there is no judgement
call and no exception.

**Amounts stay `bigint` or string, end to end.** A u64 token amount must never
pass through JavaScript `Number`, `parseInt`, `parseFloat` or `toFixed`. Above
2^53 those silently round, and a rounded amount in a payment UI is a wrong
amount. Format with the decimals of the payment's own mint -- never another
mint's, and never a mandate's when the two differ.

**Status words are fixed.** Use exactly these, with this capitalisation, and do
not invent synonyms:

| subject | permitted values |
|---|---|
| mandate | Active, Paused, Revoked |
| payment | Prepared, Submitted, Confirmed, Failed |
| receipt | Allowed, Paid, plus the seller-statement states |

"Confirmed" and "Paid" require a finalized signature and a verified on-chain
receipt. Nothing else may imply settlement -- in particular a seller delivery
statement is optional and off-chain, and never turns a receipt into Paid.

## Routes and accessibility

Use the [router](../src/routing/paths.ts): `/` for the landing page,
`/app/<tab>` for workspace routes, and `/verify/<receipt-address>` for public
receipt verification. Public verification must remain readable without a wallet.

Use semantic headings, labeled controls, visible focus, and keyboard-operable
navigation. Preserve focus restoration and Escape behavior for panels. Follow
reduced-motion preferences; motion cannot delay payment review or obscure status.

## Verify a UI change

Run the [frontend checks](../test/README.md), inspect the affected view in a
browser, and include narrow-width and keyboard checks. Match claims to evidence:
fixture screenshots prove a rendering state, not a live settlement.
