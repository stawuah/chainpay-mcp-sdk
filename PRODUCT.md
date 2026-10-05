# ChainPay

## Register

product

## Users

Owners connecting agents, approving bounded spending, and reviewing payments. The everyday workspace must be usable without understanding Solana implementation details. Developers retain an Advanced area.

## Product Purpose

Let owners authorize constrained agent spending and understand its outcomes. ChainPay remains a Solana payment rail with policy enforced on-chain, existing Axum/SDK infrastructure, and verifiable receipts.

## Brand Personality

Calm, precise, trustworthy. Preserve ChainPay's Connection identity and blue-and-white palette.

## Anti-references

Technical dashboards that expose implementation machinery everywhere; repeated instructional cards; ambiguous text-symbol icons; mixed typefaces; decorative statistics or fabricated activity.

## Design Principles

- Give each page a clear task and each record a home.
- Lead with what needs the owner's attention, then spending and agent activity.
- Explain only at the point of need; put diagnostics in details.
- Use meaningful visual information and consistent controls.
- Preserve exact amounts, uncertainty, and explicit financial approvals.

## Accessibility & Inclusion

WCAG AA contrast, visible keyboard focus, accessible dialogs, reduced motion, responsive layouts at 390/768/1440px and 200% zoom. Status is conveyed in words as well as color.

## Current work

2026-09-17: Dre approved the representative preview and the direction is now implemented in the live owner dashboard. Follow-up refinements add token artwork, precise amount controls with convenience sliders, polished receipt lookup and populated receipts, red account actions, and a centered sidebar toggle. See `docs/dashboard-redesign.md` for scope and validation. Existing marketing identity remains in the prior design guidance.

2026-10-05, upstream master `c936067`: the owner dashboard, public receipt
verification (`/verify`), `/status`, `/use-cases`, the embeddable spend
overview, and the 33-tool MCP server are in master and deployed. They were
deployed by the
[Deploy to Vercel run](https://github.com/stawuah/chainpay-mcp-sdk/actions/runs/37219312021)
to Vercel with Convex `notable-bee-447`. Agent Cards (Lithic sandbox) are in
master. Crossmint checkout, support tips and the shared pet room are in master
but closed. Owner webhooks and PayPal are not in master. Settings →
Notifications was removed rather than left as a screen that cannot save
anything.

The 5 October submission audit found places where the interface claims more
than it can show. These pending PRs fix them:

- receipts a stranger can open and honest policy captions
  ([#53](https://github.com/stawuah/chainpay-mcp-sdk/pull/53));
- card activation that waits for its public proof
  ([#52](https://github.com/stawuah/chainpay-mcp-sdk/pull/52));
- Devnet-only support tips ([#56](https://github.com/stawuah/chainpay-mcp-sdk/pull/56));
- Crossmint status that never reads a refund as delivered
  ([#55](https://github.com/stawuah/chainpay-mcp-sdk/pull/55));
- owner webhooks ([#57](https://github.com/stawuah/chainpay-mcp-sdk/pull/57));
- the PayPal v2 proposal ([#54](https://github.com/stawuah/chainpay-mcp-sdk/pull/54)).

What is implemented, what is deployed and what is live-proven are tracked
separately in `docs/project/implementation-status.md`. Each release gets one
`docs/project/release-manifest.md` record. A screen may only show a state the
evidence supports: for example, an old receipt shows today's limits, labeled
as today's.
