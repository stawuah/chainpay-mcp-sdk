---
name: chainpay-design-system
description: Design system and UI-build conventions for ChainPay (Coinbase Blue #0052ff, 100px pill buttons, calm 400-weight display type, mono numerics), plus published Astryx 0.6.1 primitives used by the Vite app. Use this whenever building, extending, or restyling any ChainPay UI so colors, type, spacing, and control APIs stay consistent.
---

# ChainPay Design System

ChainPay's UI follows a Coinbase-derived design system: a single brand blue on a
white-or-near-black canvas, pill geometry on every interactive control, display
type that stays at weight 400 (never bold), and monospace for every numeric
value.

The shipped app is a Vite + React workspace with durable routes (`/`,
`/app/<tab>`, `/verify/<pda>`). Published **Astryx 0.6.1** (`@astryxdesign/core`
and `@astryxdesign/theme-neutral`) plus StyleX 0.19 own eligible controls.
Theme import order is reset.css, astryx.css, neutral theme.css, then ChainPay
overrides in `src/theme/`. Do not reintroduce shadcn, Radix wrappers, Tailwind
JIT, or a single-file App artifact.

Read `assets/design-tokens.css` and `src/theme/chainpay-overrides.css` before
writing new UI.

## When to reach for this skill

- Any request to build, extend, or restyle ChainPay's landing page or dashboard
- Adding a dashboard section, table, form, or dialog
- Anything that should visually match the ChainPay app

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
| `--hairline` | `#dee1e6` | 1px dividers and card borders |
| `--ink` / `--body` / `--muted` / `--muted-soft` | `#0a0b0d` / `#5b616e` / `#7c828a` / `#a8acb3` | Text hierarchy. Use body/ink for essential text |
| `--up` / `--down` | `#05b169` / `#cf202f` | Status/semantic only |

**Type** - display sits at weight 400. `.t-mega`, `.t-xl`, `.t-lg`, `.t-title`,
`.t-body`, `.t-body-sm`, `.t-caption`, `.t-num` (JetBrains Mono). Inter + JetBrains Mono.

**Buttons** - pill geometry via Astryx `Button` (`label`, `isDisabled`, `onClick`,
explicit `type`). Variants: `primary`, `secondary`, `ghost`, `destructive`.
`--size-element-*` is 44px so touch targets stay usable. `IconButton` for
icon-only actions with an accessible `label`. Do not invent a package shim if a
prop is missing from 0.6.1.

**Radius / spacing / elevation** - cards `border-radius: 24px` with one shadow
tier (`--shadow-soft`). Chips/badges are fully pill. 4px spacing base.

## Astryx primitives (actual 0.6.1 exports)

| Need | Primitive | Notes |
|---|---|---|
| Actions | `Button` | `label` required; `href` for links; no children-as-label |
| Icon actions | `IconButton` | Accessible `label` + `icon` |
| Amounts, addresses, search | `TextInput` | `onChange(value, event)`. Financial fields stay text. 0.6.1 has no `inputMode` |
| Exclusive choice | `Selector` | Not `Select`. `options`, `value`, `onChange(value)` |
| Filters / signing mode | `RadioList` + `RadioListItem` | Do not fake tabs for one list |
| Real tabs | `TabList` + `Tab` | `role="tablist"` + `panelId` on associated panels |
| Tables | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell` | Semantic table; overflow stays in the table region |
| Files | `FileInput` | Controlled `File` / `File[]` / `null`; value-first `onChange` |
| Checkboxes | `CheckboxInput` | Boolean `value` |
| Dialogs | `Dialog` / `AlertDialog` | `isOpen` / `onOpenChange`. Form purpose blocks backdrop dismiss, still allows Escape |
| Wallet assets | `Popover` | Dialog semantics, Escape, focus return. Do not use a menu role for mixed content |
| Mobile destinations | `MobileNav` | All ten `/app/<tab>` destinations, including Protocol |
| Loading / clipboard | `Skeleton`, `useToast` | Toast does not replace durable payment errors |

Theme portals inherit ChainPay tokens because the root Theme syncs attributes
to `html`. Do not wrap new screens in a second router or backend.

## Copy / voice

- Buttons name the action: "Create mandate," "Pause mandate," "Revoke mandate"
- Vocabulary: **mandate**, **agent**, **recipient**, **receipt**, **spend limit**
- Status words stay exact: Active / Paused / Revoked; Prepared / Submitted / Confirmed / Failed
- Empty states are one direct sentence

## Workflow

1. Reuse token CSS and Astryx primitives above.
2. Keep amounts as bigint/string. Never convert u64 through JS Number.
3. Preserve financial handlers. Do not invent notification backends or network switching.
4. Landing stays in `landing/` with no SDK import. Receipt/verify states stay Allowed / Paid / seller-absent.
5. Respect `prefers-reduced-motion`. No document horizontal overflow.
