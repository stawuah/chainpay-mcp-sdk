# ChainPay frontend

The runnable React/Vite app: landing page, owner dashboard, payment review,
and public receipt verification. `app/` at the repository root is a separate
legacy contract scaffold.

## Run it

Follow [local development](../docs/getting-started/local-development.md).
Install root workspace dependencies and this package's dependencies separately.
From the repository root, after setup:

```bash
npm --prefix frontend run dev -- --host localhost --port 5173 --strictPort
```

Open `/app` for owner setup or `/verify/<receipt-address>` for a public receipt.
Vite loads `.env.local` inside this directory. Its values are public; never put
wallet secrets, private caller tokens, or server credentials in `VITE_*` variables.

## Work on the UI

Read [design guidance](skill/design.md), [brand rules](src/brand/README.md), and
[regression checks](test/README.md). Extend the existing Astryx components and
Connection identity. Keep public receipts independent from wallet startup.

[Product walkthrough](../docs/getting-started/try-chainpay.md) ·
[Configuration](../docs/reference/configuration.md) ·
[Receipt semantics](../docs/reference/receipts.md)
