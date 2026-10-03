# Cutover runbook: Render + Neon → Vercel + Convex

This is the 30-minute window that moves ChainPay's off-chain data into
production Convex and puts real users on the Vercel stack. Background,
settings and rollback rules: [Vercel + Convex handoff](vercel-convex-handoff.md).

## Who does what

- **Kwasi (Render owner):** suspends the Render services and, afterwards, points
  the old Render website at the new one.
- **Dre (Vercel + Convex owner):** runs `scripts/cutover-vercel-convex.sh` and
  merges this PR at the step below.

Nothing here sends a Solana transaction, upgrades the program, or enables Crossmint.

## Already done before the window

- The rehearsal passed on 3 October 2026. A read-only Neon export (47 rows) was
  imported into a throwaway Convex deployment, exported back, and restored into an
  empty Postgres. All 13 tables matched by count and hash at each step.
- Production Convex is `notable-bee-447`. Its schema is deployed and its 3
  service secrets are set. It is empty, with `CHAINPAY_MAINTENANCE=true`.
- Vercel's production settings carry the Render provider settings (Privy,
  OpenRouter, the auth token). The Convex settings are split, so production
  switches while preview stays on the dev database.
- The release guard (`scripts/check-release-env.mjs`) now runs in every hosted
  build. After this PR merges, a production build fails unless all 3 services
  point at the **prod** Convex deployment and exact HTTPS origins.

## Before the window

1. Merge the auto-deploy PR (#33) first.
2. Dre: `~/.config/chainpay/convex-prod.env` exists (mode 600). It holds the
   production deploy key, site URL and service secrets. Never commit it.
3. Dre: export `CHAINPAY_SOURCE_DATABASE_URL` as Neon's primary connection
   string in the shell that runs the script.
4. Check out this branch and run `npm ci --ignore-scripts`.

## The window (about 30 minutes)

| # | Who | Do | Stops if |
|---|---|---|---|
| 1 | Kwasi | On Render, **suspend** `chainpay-backend`, `chainpay-mcp` and the keep-alive job. A maintenance banner is not enough. | — |
| 2 | Dre | `scripts/cutover-vercel-convex.sh preflight` | Render still answers, or prod Convex isn't empty or isn't in maintenance |
| 3 | Dre | `scripts/cutover-vercel-convex.sh migrate`: final Neon export, import, round-trip compare | Any table differs |
| 4 | Dre | `scripts/cutover-vercel-convex.sh switch`: Vercel production → prod Convex, exact web origin only | A setting can't be written |
| 5 | Dre | Merge this PR. Release checks run, then Convex → relay + MCP → website deploy (about 10 min) | The release guard rejects a setting, or a build fails |
| 6 | Dre | `scripts/cutover-vercel-convex.sh open`: production Convex accepts writes | — |
| 7 | Dre | `scripts/cutover-vercel-convex.sh smoke`: wallet-message login, CORS, owner isolation (no transaction) | Any check fails |
| 8 | Kwasi | Point users at `https://chainpay-web-kappa.vercel.app` (redirect or replace the Render static site). Update MCP clients to `https://chainpay-mcp.vercel.app/mcp`. | — |

If **any step up to and including 5** fails: run `scripts/cutover-vercel-convex.sh abort`,
and Kwasi resumes the Render services. Neon was never written to, so nothing is lost.

After step 6, Convex holds the newest writes. Rollback then needs another write pause, a
**fresh** `export-convex`, and `restore-postgres` into an empty Postgres. Never
point Render back at the old Neon data.

## After the window

- Keep the Render services suspended (not deleted) and the snapshot in
  `.migration/cutover-<date>/` for 7 days, then delete both.
- Rotate the Neon password and the OpenRouter key. Both were shared over chat.
- Fix the typo in Render's backend `CHAINPAY_ALLOWED_ORIGINS` (`localhost:517`)
  if Render is kept for anything.
- In a later PR, after a quiet week, remove `render.yaml` and the keep-alive job.
