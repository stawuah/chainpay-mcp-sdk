# ChainPay SDK

TypeScript tools for reading mandates and receipts and building Solana payment
transactions. Wallets and approved signer providers sign outside the SDK.

**Start with [a read-only SDK example](../docs/guides/use-the-sdk.md).**

From the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm --prefix sdk run build
npm --prefix sdk run test
```

This is a private npm workspace package, consumed locally as `@chainpay/sdk`.
Do not assume an npm registry release.

- [Integration guide](../docs/guides/use-the-sdk.md): first read, signing boundary, token support, and transaction codecs.
- [Public exports](src/index.ts), [client methods](src/client.ts), and [types](src/types.ts): implementation reference.
- [Payment-agent guide](../docs/guides/connect-an-agent.md): MCP integration and caller authorization.
- [Documentation index](../docs/README.md).

## Preparing wallet token accounts

`prepareAssociatedTokenAccount({ owner, mint, payer })` checks that the mint is
enabled in the on-chain asset registry, validates its token program, and checks
the owner's canonical associated token account. It returns `status: "ready"`
when the account exists or an unsigned, single-instruction transaction when it
is missing. The caller must show that transaction to the wallet for approval.

`prepareRegisteredAssetTokenAccounts(owner)` performs the same inspection for
every enabled registry asset. Disabled assets are excluded. Neither method
submits a transaction, funds an account, or grants a spending permission.
