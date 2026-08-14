# ChainPay Dashboard — Page-by-Page UI/UX Spec

For an AI (or a human) building these pages against `ChainPayFlow.jsx` and
`chainpay-design-system` — every class name, component, and data shape below
already exists in the shipped artifact or follows its conventions exactly.
Nothing here introduces a new color, radius, shadow, or button style.

**Shared shell, all 8 pages:**
- Sidebar (`.sidebar`, hidden under 900px behind `.mobile-nav-panel`) — nav
  order below.
- Topbar (`.topbar`): search pill, `Devnet` chip, wallet chip, avatar.
- Content wrapper: `cp-container`, `padding: 28px 24px 64px`, page title as
  `t-lg` + primary action button top-right when the page has one primary
  action.
- Every list/table lives inside one `card-surface` with `.table-row` children
  — never a raw `<table>`. Every status uses the existing `statusChip()`
  chip classes (`chip-up` / `chip-yellow` / `chip-down` / `chip-muted`).
- Empty states are one `t-body-sm` sentence, centered, no illustration.

**Sidebar nav order (update from 5 to 8 items):**
```
Overview
Mandates
Payments
Agents
Receipts
Tools           <- new
Connect MCP     <- new
──────────────  (separator, same as current "Back to site" divider)
Settings        <- new, moved out of primary group into the utility group
Back to site
```
`Settings` already exists as an unwired sidebar button — wire it to a real
page instead of adding a second one.

---

## 1. Overview
**Purpose:** account health at a glance.

**Layout:** stat row, then one activity feed. Already fully built — no
changes needed. Documented here for completeness / as the reference pattern
for stat rows elsewhere.

- Stat row: `grid, repeat(auto-fit,minmax(200px,1fr)), gap:16px` — four
  `card-surface stat-card`: **Active mandates** (count), **Spent this month**
  (`$`, `t-num`), **Pending payments** (count), **Agents connected** (count).
- Below: one `card-surface`, title "Recent activity", `.table-row` per entry
  — avatar-ring initials, description + relative time, amount (`t-num`),
  status chip.

**Empty state:** "No activity yet — payments will show up here once an agent
makes one."

**Interactions:** "New mandate" button opens the shared `Dialog` (same one
used from Mandates). Activity rows are static in v1 (not clickable).

---

## 2. Mandates
**Purpose:** manage every spending policy.

**Layout:** already built — filter `Tabs` (`all` / `active` / `paused` /
`revoked`, `.cp-tab`) above one `card-surface` table.

- Row grid: `1.8fr 1fr 1.5fr 1fr 1fr auto` — agent (avatar + name +
  recipient), stablecoin (`TokenDot` + program label), spent/limit (`t-num` +
  `Progress`), expiry date, status chip, actions (pause/resume + revoke icon
  buttons, each wrapped in `Tooltip`).

**Empty state:** "No mandates match this filter."

**Interactions:** pause ↔ resume toggles `Active`/`Paused`; revoke sets
`Revoked` (terminal — both action icons disappear once revoked, matching the
shipped logic).

---

## 3. Payments
**Purpose:** the full payment log — every attempt, not just settled ones.

**Layout:** already built as a plain feed identical in row-shape to
Overview's activity list, just unfiltered and complete.

**Recommended next iteration (not yet shipped):** add the same status-`Tabs`
filter pattern used on Mandates (`All` / `Confirmed` / `Pending` / `Failed`),
so a person can isolate failures without scanning the whole feed. Same
`.cp-tab` classes, same position (directly under the page title).

**Empty state:** "No payments yet."

---

## 4. Agents
**Purpose:** registry of agents allowed to call ChainPay, and what each
currently holds.

**Layout:** already built — card grid, `repeat(auto-fit,minmax(240px,1fr))`.

- Each `card-surface`: avatar-ring (top-left) + status chip (top-right),
  agent name (`t-title`), pubkey (`t-num`, muted), "N active mandate(s)"
  line.

**New addition:** page header gets a secondary button, **"Connect an
agent"** (`.btn-secondary-light`), that navigates to the new **Connect MCP**
page rather than opening a dialog here — agent identity is created there;
this page only reads the result.

**Empty state:** "No agents connected yet." + one primary button, "Connect
an agent" → Connect MCP.

---

## 5. Receipts
**Purpose:** durable settlement records — the audit trail.

**Layout:** already built — `card-surface`, row grid `1fr 1.4fr 1fr 1.6fr`:
invoice id (`t-num`), agent, amount (`t-num`), a 3-dot stepper
(Prepared → Submitted → Confirmed) using `CheckCircle2`/`Circle` exactly as
shipped.

**Empty state:** "No receipts yet — they appear once a payment settles."

**Recommended next iteration:** make rows clickable → a receipt detail view
(invoice hash, on-chain signature with an explorer link, mandate reference).
Not required for v1 parity.

---

## 6. Tools *(new)*
**Purpose:** make the exact MCP tool surface agents can call visible to the
human — nothing an agent can do should be a mystery. Maps 1:1 to the MCP
tool schema (`get_mandate`, `prepare_payment`, `execute_payment`,
`get_payment`).

**Layout:**
- Header: `t-lg` "Tools" + `t-body-sm` subtitle: "The exact tools agents can
  call. Nothing else is exposed."
- One `card-surface` per tool, stacked with normal card spacing (not a
  dense table — these are reference cards, not data rows):
  - Row 1: tool name as a mono chip (`t-num` inside a `chip chip-blue`,
    e.g. `prepare_payment`), plus a right-aligned access chip —
    `chip-muted` "All connected agents" (or a specific agent name once
    per-agent scoping exists).
  - Row 2: one-line `t-body-sm` description (reuse the exact strings already
    drafted in the PRD's MCP tool schema).
  - Collapsible footer (shadcn `Collapsible`, chevron toggle,
    label "Input schema"): reveals the tool's JSON input schema in a
    code block — background `var(--strong)`, `t-num`, `border-radius: 12px`,
    padding 16px. Collapsed by default.
- No live "try it" console in v1 — static reference only. Note this
  explicitly if a future version adds one, since a live console changes the
  trust story (would need its own auth/sandbox treatment).

**Components:** `Card`, `chip` classes, shadcn `Collapsible` (new addition to
the component table — Radix `Collapsible`, import from
`@/components/ui/collapsible`).

**Empty state:** not applicable — this list is static/system-defined, always
populated.

---

## 7. Settings *(new)*
**Purpose:** account-level configuration: network, wallet, notifications,
destructive actions.

**Layout:** page title `t-lg` "Settings", then a horizontal `Tabs` bar
(`.cp-tab`) with three sections rendered below it — **General**,
**Notifications**, **Danger zone**. Each section is its own `card-surface`,
`padding: 24px`, fields stacked with the same `Label` + `Input`/`Select`
pattern already used in the New Mandate dialog.

- **General:**
  - Network: `Select` — `Devnet` / `Mainnet-beta` (Devnet selected,
    matches the topbar chip).
  - Wallet address: read-only `t-num` value + a small `.btn-icon` copy
    button beside it (no edit — wallet identity isn't editable here).
- **Notifications:**
  - Webhook URL: `Label` + `Input` (`placeholder: "https://"`) + a
    `.btn-secondary-light` "Save" button, right-aligned below the field.
  - One `Switch` row: label "Email me when a mandate nears its limit,"
    switch right-aligned, same row height as a `.table-row`.
- **Danger zone:**
  - `card-surface` with a `1px solid var(--down)` border override
    (only place in the whole app a card's border isn't `--hairline` —
    reserve red borders exclusively for this section, don't reuse
    elsewhere).
  - Two rows, each: description text left, one button right —
    "Revoke all mandates" and "Disconnect wallet." Both buttons are
    `.btn-secondary-light` with `color: var(--down)` inline override
    (not a new `.btn-danger` class — one-off, this is the only place it's
    needed).
  - Both actions open a confirm `Dialog` before executing — title states
    the exact consequence ("This immediately revokes every active mandate.
    Agents will not be able to request payments until you create new
    ones."), no soft "are you sure?" phrasing.

**Components:** `Tabs`, `Select`, `Input`, `Switch` (new addition to the
component table — `@/components/ui/switch`), `Dialog`, `Label`.

---

## 8. Connect MCP *(new)*
**Purpose:** pair an agent / MCP client to ChainPay. This is the identity
step that populates the Agents page — Agents reads the result, this page
creates it.

**Layout:**
- Header: `t-lg` "Connect MCP" + `t-body-sm` subtitle: "Pair an agent so it
  can call ChainPay's tools. It never gets your wallet key."
- **Connection config card** (`card-surface`, padding 24px):
  - `t-title` "Server config"
  - Server URL row: `t-num` value + `.btn-icon` copy button.
  - Below it, a ready-to-paste JSON config block (same dark code-block
    treatment as the Tools page schema view: `var(--strong)` background,
    `t-num`, `border-radius: 12px`), with a `.btn-secondary-light` "Copy
    config" button pinned top-right of the block.
- **Connected clients** (`card-surface`, `.table-row` list, grid
  `2fr 1fr 1fr auto`): agent name, scope chip (`chip-muted` "Scoped
  access"), "Connected since" date, action — `.btn-icon` revoke (`Ban`
  icon) wrapped in `Tooltip`, opens the same style confirm `Dialog` as
  Settings' danger zone before revoking.
- Page-level primary button, top-right of the header: **"New connection"**
  → `Dialog`:
  - `Input` — agent name.
  - `Select` — scope (optional: tie to an existing mandate, or leave
    unscoped to configure later).
  - On submit: generate and display a token **once**, in a `t-num` block
    with a copy button and a `t-body-sm` caption underneath in `var(--down)`:
    "Shown once. Store it securely." — this is the one place copy
    deliberately breaks from calm/neutral into an explicit warning color,
    because the cost of missing it is real.

**Components:** `Card`, `Input`, `Select`, `Dialog`, chip classes,
`Tooltip`, `.btn-icon`.

**Empty state:** "No agents connected yet." + the same "New connection"
button, centered, first-run framing.

---

## Component table additions

Add these two rows to the `chainpay-design-system` component table —
everything else needed for the new pages already exists:

| Need | Component | Import |
|---|---|---|
| Expandable tool schema (Tools page) | `Collapsible` | `@/components/ui/collapsible` |
| Notification toggle (Settings page) | `Switch` | `@/components/ui/switch` |

## Build order

If building these as one artifact update rather than all at once:
1. Wire `Settings` first — it's self-contained, no cross-page dependency.
2. Build `Connect MCP` second — establishes the `agents` data shape addition
   (connection date, scope) that `Agents` and `Tools` both read from.
3. Build `Tools` last — purely presentational, depends on nothing new.