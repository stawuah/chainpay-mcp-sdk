---
name: chainpay-design-system
description: Design system and UI-build conventions for ChainPay (Coinbase Blue #0052ff, 100px pill buttons, calm 400-weight display type, mono numerics), plus the shadcn/ui and Radix UI patterns used to ship its marketing site and dashboard as single-file React artifacts. Use this whenever building, extending, or restyling any ChainPay UI - new dashboard pages, forms, marketing sections, or one-off components - so colors, type scale, spacing, buttons, badges, and component choices stay consistent with what already shipped. Also covers Tailwind and shadcn gotchas specific to this artifact environment (no arbitrary-value classes, CSS variable inheritance across Radix portals) so new components don't silently break styling. Trigger this proactively any time the person mentions ChainPay's UI, dashboard, landing page, or asks for a new screen/component/flow for it, even if they don't name the skill.
---

# ChainPay Design System

ChainPay's UI follows a Coinbase-derived design system: a single brand blue on a
white-or-near-black canvas, pill geometry on every interactive control, display
type that stays at weight 400 (never bold), and monospace for every numeric
value. This skill exists so every new screen looks like it shipped with the
first one, instead of drifting toward generic AI-slop defaults (gradient
heroes, purple-on-black, bold display type, arbitrary rounded-xl cards).

Built React artifacts so far: the marketing landing page and the dashboard
(Overview, Mandates, Payments, Agents, Receipts, New Mandate dialog). Read
`assets/design-tokens.css` before writing any new ChainPay UI - it's the exact,
already-tested stylesheet from the shipped artifact, not a re-derivation.

## When to reach for this skill

- Any request to build, extend, or restyle ChainPay's landing page or dashboard
- Adding a new dashboard section, table, form, or dialog
- Anything that should visually match "the ChainPay app" even if the person
  doesn't repeat the brand/color spec
- A request to make a *different* product's UI in the same style - reuse the
  token system, but see "Reusing this outside ChainPay" below

## Core tokens (full detail in assets/design-tokens.css)

**Color** - one brand voltage, everything else monochrome:
| Token | Hex | Use |
|---|---|---|
| `--blue` | `#0052ff` | Primary CTAs, links, active states |
| `--blue-active` | `#003ecc` | Press/hover state |
| `--blue-disabled` | `#a8b8cc` | Disabled CTA |
| `--yellow` | `#f4b000` | Sparingly - illustrative accent only, not a second CTA color |
| `--canvas` / `--soft` / `--strong` | `#fff` / `#f7f7f7` / `#eef0f3` | Page floor, alternating band, secondary surfaces |
| `--dark` / `--dark-elevated` | `#0a0b0d` / `#16181c` | Full-bleed dark hero, floating card surfaces on dark |
| `--hairline` | `#dee1e6` | 1px dividers and card borders - the only border weight used |
| `--ink` / `--body` / `--muted` / `--muted-soft` | `#0a0b0d` / `#5b616e` / `#7c828a` / `#a8acb3` | Text hierarchy, darkest to lightest |
| `--up` / `--down` | `#05b169` / `#cf202f` | Status/semantic only (confirmed vs failed) - never decorative |

**Type** - display sits at weight 400, always. Classes already defined:
`.t-mega` (44/64/80px responsive), `.t-xl`, `.t-lg`, `.t-title` (18/600),
`.t-body`, `.t-body-sm`, `.t-caption` (12/600/uppercase, section labels only),
`.t-num` (JetBrains Mono, every dollar amount / balance / pubkey / hash).
Fonts load via `@import` in the stylesheet: Inter (sans) + JetBrains Mono.

**Buttons** - pill geometry, no exceptions: `.btn` (100px radius, 44px height),
`.btn-lg` (56px, hero only), `.btn-primary`, `.btn-secondary-light`,
`.btn-secondary-dark` (on dark surfaces), `.btn-outline-dark`, `.btn-text`
(tertiary link, blue, no background), `.btn-icon` (34px circular, table
row actions). Never use a shadcn `Button`'s default `rounded-md` look
unqualified - see "shadcn re-skinning" below.

**Radius / spacing / elevation** - cards are `border-radius: 24px`
(`.card-surface`, `.card-dark`) with a single shadow tier
(`--shadow-soft: 0 4px 12px rgba(0,0,0,0.04)`) plus a 1px hairline border;
80% of surfaces should be flat with no shadow at all. Chips/badges/tokens are
always fully pill (`border-radius: 100px`). Spacing follows a 4px base
scale; section rhythm is generous (64-96px vertical padding between major
sections) - don't cram sections tighter than that.

## shadcn/ui + Radix components already wired in

| Need | Component | Import | Note |
|---|---|---|---|
| Modal form (new mandate, etc.) | `Dialog` | `@/components/ui/dialog` | See portal gotcha below |
| Dropdown choice (agent, stablecoin, expiry) | `Select` | `@/components/ui/select` | Portals too - same gotcha |
| Filter switcher (All/Active/Paused/Revoked) | `Tabs` | `@/components/ui/tabs` | Only for real category switches, not page nav |
| Spend/limit bars | `Progress` | `@/components/ui/progress` | Indicator re-skinned blue globally, see below |
| Row actions (pause/revoke) | `Tooltip` | `@/components/ui/tooltip` | Wrap the whole dashboard in one `TooltipProvider` |
| Agent/user initials | `Avatar` + `AvatarFallback` | `@/components/ui/avatar` | Background set inline per-agent, see `AGENT_COLORS` |
| Card surfaces | `Card` | `@/components/ui/card` | Used as a bare styled wrapper; skip `CardHeader`/`CardContent`, hand-pad instead |
| Text inputs, labels, dividers | `Input`, `Label`, `Separator` | `@/components/ui/*` | Used as-is, no re-skin needed |

Icons: `lucide-react`, one import block at the top, only the icons actually
rendered (check with a quick `grep` before shipping - dead icon imports crept
in during the first draft and had to be cleaned up).

## Gotchas learned building v1 (read before you skip these)

1. **No Tailwind arbitrary-value classes.** This environment has no JIT
   compiler - only pre-defined core utilities work. `bg-[#0052ff]` silently
   does nothing. Brand colors, exact radii, and typography live in
   `assets/design-tokens.css` as real CSS classes (`.btn-primary`,
   `.t-mega`, etc.), applied via `className`. Use Tailwind only for generic
   layout: `flex`, `grid`, `gap-4`, gap/width utilities, responsive prefixes
   (`md:`, `lg:`) - all core, all safe.

2. **Radix portals break CSS variable inheritance.** `Dialog`, `Select`, and
   `Tooltip` content render into `document.body`, outside the DOM subtree
   that defines `--blue`, `--ink`, etc. on `.cp-app`. Any portaled content
   that uses those variables needs the `cp-app` class reapplied directly on
   it (see `DialogContent className="cp-app"` in the shipped artifact) or
   the variables resolve to nothing and buttons render unstyled.

3. **Re-skin shadcn internals with targeted `!important`, not by fighting
   specificity.** shadcn ships its own default utility classes (`bg-primary`
   etc.) tied to a neutral default theme. Don't try to out-specificity them -
   add one or two global rules with `!important` for the handful of elements
   that need brand color (`[role="progressbar"] > div`,
   `[data-state="active"].cp-tab`), and leave the rest of each component's
   internal chrome (popover shadows, focus rings) as shipped - it's already
   neutral enough not to clash.

4. **One shadow tier, no exceptions.** If a new card needs to feel "raised,"
   reach for the hairline border first, `--shadow-soft` second, and never
   stack multiple shadow weights - the whole system reads as calm specifically
   because it doesn't.

5. **Animation budget: one signature moment per screen, everything else
   quiet.** The hero's floating mandate/request/receipt cards
   (`.floaty`, staggered `animation-delay`) and the "how it works" traveling
   dot (`.how-dot` / `segTravel`) are the signature moments. Don't add a
   third. Micro-motion elsewhere (`.pulse-dot` for in-flight status, the
   `.view-enter` fade-slide on navigation) should stay subtle and always
   respect `prefers-reduced-motion` (already handled globally in the
   stylesheet - don't remove that block).

## Copy / voice

Plain, active voice, no filler - the brief called for "no verbosity" and it's
now the house style:
- Buttons name the action, not a generic verb: "Create mandate," "Pause
  mandate," "Revoke mandate" - never "Submit" or "Confirm."
- Vocabulary is fixed: **mandate** (not "permission" or "rule"), **agent**
  (not "bot" in UI copy, `Bot` is only the icon), **recipient**, **receipt**
  (not "transaction record"), **spend limit** / **max per payment**.
- Status words are exact and match the badge shown elsewhere in the app:
  Active / Paused / Revoked for mandates, Prepared / Submitted / Confirmed /
  Failed for payments. Don't invent synonyms for these in new copy.
- Empty states get one direct sentence ("No mandates match this filter"), not
  an illustration or a paragraph.

## Workflow for a new ChainPay screen or component

1. Read `assets/design-tokens.css` and reuse its classes - don't redefine
   `--blue` or rebuild `.btn-primary` from scratch in a new artifact.
2. Reuse the mock-data shape already established (`mandates`, `activity`,
   `receipts`, `agentsList` fields) if the new screen shows the same
   entities, so a future merge into one artifact is a copy-paste, not a
   rewrite.
3. Pick components from the table above before reaching for a raw `<div>` -
   if the need doesn't map to a row in that table, it's fine to hand-roll,
   but check first.
4. Keep the single-signature-animation rule from the gotchas section.
5. If the deliverable is a full React artifact, sanity-check it with esbuild
   before presenting (`npx esbuild file.jsx --jsx=automatic --format=esm
   --bundle=false --outfile=/tmp/out.js`) - it won't resolve `@/components/*`
   imports, but it will catch real syntax errors before the person sees them.

## Reusing this outside ChainPay

The token system (color roles, type scale, pill/radius/shadow rules,
portal + Tailwind gotchas) is product-agnostic and safe to reuse for another
project's UI. The copy vocabulary and mock-data shapes in this file are
ChainPay-specific and should be swapped for the new product's own domain
language rather than carried over.

## ON THE WEBSITE

The universal payment rail for AI agents.
One MCP endpoint for policy enforcement, wallet authorization, routing, stablecoin settlement, and receipts. Solana is the first settlement layer.

Solana Devnet · Policy first


Connect wallet
→
See how it works
→
◇
One interface for every rail
✓ Policy before payment
✓ Receipt for every settlement
EXAMPLE MANDATE
Active
$2,000.00
Available agent spend
Max per payment
10 USDC
Approved recipient
Merchant…a4f2
Expires
7 days
Amount spent
20.5 USDC / 100 USDC
✓
Payment settled
Receipt verified on-chain
+4.50
✦
Agent authority
Limited by ChainPay
CONTROL CENTER
Move money with confidence.
Program live on Devnet
EXAMPLE POLICY
$2,000.00
Illustrative Devnet flow

◇
1H
1D
1W
1M
1Y
All
$2,000.00
QUICK ACTIONS
What do you need?
MCP

↗
Send
Route a policy-checked payment
→

↙
Receive
Share a stablecoin destination
→

✦
Approve mandate
Give an agent limited authority
→

▤
Receipts
Review durable settlement proof
→
◇
Send selected
Route a policy-checked payment
SUPPORTED RAILS
Built for stablecoin settlement.
Connect the assets your agents already use. ChainPay handles the policy; Solana handles settlement.

View all assets
→
$
···
Devnet USDC
USDC / DEVNET
$1.00
+0.01%
Route payment
→
◈
···
Token-2022
USDC-2022 / DEVNET
$1.00
+0.02%
Route payment
→
✓
···
ChainPay receipt
RECEIPT / DEVNET
Verified
On-chain
View receipts
→
USE CASES
One interface. Every agent payment.
If an agent needs to move money, it calls ChainPay. The agent does not need to understand the underlying wallet, connector, or settlement rail.

See the flow
→
01
Treasury approvals
Set a capped transfer policy.

Agents can request payments without receiving unrestricted wallet access.

02
Merchant settlement
Route every invoice through one policy.

Preflight the recipient, mint, amount, and mandate before signing.

03
Programmatic payouts
Keep recipients and limits explicit.

The protocol records the request and returns a durable receipt.

04
Reconciliation
Verify the settlement later.

Look up the receipt PDA and transaction signature from MCP.

DEMO ACTIVITY
Stay in control.
Example feed
#
Activity
Amount
Status
Time
01
◆
Mandate created
@agent_aurora
10 USDC
Active
2m ago
→
02
↗
Payment settled
@merchant_one
4.50 USDC
Settled
18m ago
→
03
✓
Receipt verified
@procure_bot
32 USDC
Verified
1h ago
→
04
✦
Policy updated
@chainpay
Devnet
Updated
3h ago
→
◇
ChainPay policies are enforced by the Solana program. Agents never receive your private key or unrestricted wallet access.
WHY CHAINPAY
Your money.
Your rules.
Give an agent a mandate with a clear limit, recipient, and expiry. You keep the signing key.

Learn about mandates
→
On-chain
Policy enforcement
Wallet
Always approves signing
One
Receipt per settlement
Devnet
Start with a safe demo
SIMPLE STEPS
Start routing in minutes.
From wallet connection to verified settlement, ChainPay keeps every step visible.

01.
◈
Connect wallet
Connect your Solana wallet on Devnet. Your private key stays with you.

02.
◇
Create a mandate
Choose a token, recipient, spend limit, and expiration for your agent.

03.
✦
Let agents request
Agents use MCP or the SDK. ChainPay checks every request on-chain.

04.
▤
Verify settlement
Successful payments create durable receipts for everyone to reconcile.

READY WHEN YOU ARE
Give agents one payment interface.
Keep the control.
Create your first policy and connect a settlement rail on Solana Devnet.

Get started
→
chainpay
The universal payment rail for AI agents.

Program active · Devnet
PRODUCTS
Mandates
Payments
Use cases
Receipts
BUILD
How it works
MCP tools
Connectors
Status
LEGAL
Privacy Policy
Terms of Service
Risk disclosure
Stay in the loop
Product updates, protocol news, and Devnet drops.

Your email
→
© 2026 ChainPay. Built on Solana.
Program 
3H9T…ndv4
⧉