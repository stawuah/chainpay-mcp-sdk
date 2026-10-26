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

## Visual layer: "take two"

`src/theme/take-two.css` is the current visual layer. It loads once from
`main.tsx` (and from every browser fixture) and sits on top of
`workspace.css`, `receipt-card.css` and the public page sheets. It wins by
specificity (`html[data-astryx-theme] …`), never by load order. It changes
scale, depth, rhythm and motion and nothing else: no route, status word,
amount, logo or brand colour moves.

- Blue is a surface, not only an accent: the Overview spending card is a
  blue slab with the remaining allowance as its headline, and the permission
  builder shows a live blue permission card that rewrites as the limits change.
- The sidebar opens as an icon rail (labels on hover, attention counts as a
  corner badge); the handle expands it and the choice is remembered.
- The top bar is sticky and translucent.
- A prepared payment shows a pay sheet: amount first, the permission it runs
  under, then a three-rung ladder using the fixed words Prepared, Submitted,
  Confirmed. A failed step turns red and keeps its word.
- Receipts (dashboard preview, inbox and `/verify`) render as an ink statement
  with a green Paid seal. Print output is unchanged (`receipts/print.ts`).
- Motion: groups rise in on entry, rows lift on hover, buttons press to 98%.
  Amounts and the usage ring never animate. Reduced motion lands everything
  instantly.

Add new rules to `take-two.css` under the matching section rather than to the
older sheets, and keep the `html[data-astryx-theme]` prefix so they outrank
the legacy cascade.

The PayPal workspace (`src/paypal/`) has its own layer, `paypal-two.css`, with
the same rules: it loads after `paypal.css`, wins by specificity, and changes
nothing but surfaces, scale and motion. Its headline number is the net buyer
cost on a blue slab; the four lifecycle stages render as a ladder of bars; the
sign-in page pairs the form with a blue slab that names the three roles.

The allowance builder in that workspace (`Allowances.tsx`) carries the same
live blue permission card as the Colosseum builder: `.paypal-permission-card`
rewrites its plain-English sentence and its rows on every keystroke, so the
buyer reads exactly what the agent will be allowed to do before creating it.
Allowance status pills use only the words Active, Paused and Revoked; the
buttons that move them are Pause, Resume and Revoke. Dollar amounts a person
types become integer cents by regex and string work (`centsFromDollars`), never
through `parseFloat`, and cents from the API are shown through `dollars()` and
`shownMoney`. The agent's view of an allowance never includes the payment
method; keep that word and the approval link out of any copy an agent can see.
The marketplace quote verdict shows the reason code beside its plain words.

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
  Name where limits beside a receipt came from: recorded on Solana at
  payment, seen by the ChainPay relay after payment, or today's limits when
  neither exists. Never present today's limits as the limits at payment.
- Request content (description, line items) appears only to the owner, or on
  `/verify` from an audit link the owner shared, after it verifies against the
  receipt. A plain public receipt shows none of it.
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
