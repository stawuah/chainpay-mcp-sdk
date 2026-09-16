# Maintaining the documentation

Keep one current explanation for each topic. The root README explains the
product and first use; the [documentation index](../README.md) routes readers
to procedures, reference material, and evidence.

## Where content belongs

| Location | Purpose |
| --- | --- |
| `getting-started/` | First product journey, local setup, troubleshooting |
| `guides/` | Agent, SDK, and merchant integration procedures |
| `reference/` | Architecture, configuration, settlement, networks, receipts, recovery |
| `project/` | Acceptance, implementation evidence, dependency history, maintenance |
| `archive/` | Clearly labeled historical proposals and code explanations |

Component READMEs explain that component and link to shared instructions.
The hosted MCP documentation presents the same connection boundary; its tool
cards are generated from the current registry rather than a copied list.

## Document audit — 2026-09-15

The cleanup is based on the fork's owner-onboarding stack at commit `8766573`.
The scope document is retained unchanged. The following map accounts for all
Markdown documents present before cleanup; filenames in the left column are
historical locations, not links to active copies.

| Original document | Disposition / current entry |
| --- | --- |
| Root README | Rewritten around understanding, first use, and reader paths |
| `backend/README.md`, `demo-merchant/README.md`, `programs/chainpay/README.md`, `scripts/README.md` | Retained and corrected component procedures |
| `sdk/README.md`, `mcp-server/README.md` | Condensed; shared integration detail moved to guides |
| `docs/scope.md` | Retained unchanged as product authority |
| `docs/networks.md` | [Networks](../reference/networks.md); corrected unsupported hook claim |
| `docs/token-account-payment-flow.md` | [Token accounts](../reference/token-accounts.md); corrected address and preparation behavior |
| `docs/settlement-recovery.md` | [Recovery](../reference/settlement-recovery.md); old path forwards because runtime errors cite it |
| `docs/trusted-sellers.md` | [Trusted sellers](../guides/trusted-sellers.md); retained evidence boundaries |
| `docs/local-e2e-testing.md` | [Acceptance runbook](local-e2e-testing.md); corrected authentication and verifier claims |
| `docs/dependency-advisories.md` | [Dependency record](dependency-advisories.md); existing disposition retained |
| `chainpay_skill/IMPLEMENTATION_STATUS.md` | [Implementation status](implementation-status.md); old path forwards for existing agent instructions |
| `chainpay_skill/agent.md` | [Agent connection guide](../guides/connect-an-agent.md); obsolete auth and unavailable tools removed; old path forwards |
| `chainpay_skill/skill.md` | [AGENTS.md](../../AGENTS.md); old path forwards |
| `chainpay_skill/prd.md`, `chainpay_skill/architecture.md` | Preserved in [archive](../archive/README.md); no longer active implementation instructions |
| `coderead.md` | Historical [code walkthrough](../archive/code-walkthrough.md) |
| `scoin.md` | Condensed into current [settlement reference](../reference/settlement.md) |
| `frontend/skill/design.md` | Rewritten to match implemented Connection identity and Astryx conventions |
| `frontend/skill/page-by-page-ux.md` | Historical [dashboard proposal](../archive/dashboard-proposal.md); runtime assets remain in place |
| `frontend/test/README.md` | Retained regression guide; added current onboarding browser check |
| `frontend/src/brand/README.md`, `frontend/src/assets/brands/README.md` | Retained current logo and third-party asset provenance rules |

New entry points include the documentation index, product walkthrough, local
setup, troubleshooting, integration guides, architecture/configuration/receipt
references, frontend README, contribution guide, and root coding-agent instructions.

## Updating a guide

1. Verify claims against the source, tool schemas, tests, and configuration
   loaders. Mark roadmap or historical evidence explicitly.
2. Write the reader's goal first. Give prerequisites, numbered actions, and the
   result they should see. Keep commands runnable from the stated directory.
3. Check internal links and anchors, including component READMEs and forwarding
   files. Use relative repository links so forks and clones remain navigable.
4. Render the changed Markdown at desktop and mobile widths in light and dark
   themes. Check images, tables, code overflow, and heading order.
5. Run applicable read-only examples and record their limits. No setup-doc
   check authorizes a payment, shared-database migration, or deployment.

GitHub's [README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
explains its outline, section anchors, and relative links. Longer procedures
belong here rather than in an expanding root README.

## Screenshot provenance

`docs/assets/owner-setup.png` captures the actual disconnected `/app` route
at a 1280×860 viewport and 2× pixel density, with reduced motion, from this
fork's `8766573` UI. It contains no fixture wallet, sample balances, or sample
settlements. The screenshot is an illustration of the interface, not evidence
of a payment. Re-capture from the application when the UI changes.

The Connection symbol comes from the existing public brand export. GitHub
controls the surrounding README typography; keep text selectable and provide
useful alt text instead of rendering paragraphs into images.
