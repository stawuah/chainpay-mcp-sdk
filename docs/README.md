# ChainPay documentation

**New to ChainPay? [Follow the product walkthrough](getting-started/try-chainpay.md).**
It takes you from wallet setup to a payment receipt on Solana Devnet.

## Choose your next step

| You want to… | Read |
| --- | --- |
| Try or run the product | [Walkthrough](getting-started/try-chainpay.md) · [Local development](getting-started/local-development.md) · [Troubleshooting](getting-started/troubleshooting.md) |
| Connect an agent or application | [MCP](guides/connect-an-agent.md) · [TypeScript SDK](guides/use-the-sdk.md) |
| Accept payments | [Merchant integration](guides/merchant-integration.md) · [Trusted seller configuration](guides/trusted-sellers.md) |
| Understand the protocol | [Architecture](reference/architecture.md) · [Settlement](reference/settlement.md) · [Receipts](reference/receipts.md) |
| Contribute or verify a change | [Contributing](../CONTRIBUTING.md) · [Coding agent instructions](../AGENTS.md) · [Acceptance runbook](project/local-e2e-testing.md) |

## Reference

- [Configuration](reference/configuration.md): which settings belong to which service.
- [Networks and assets](reference/networks.md): Devnet mints and supported token behavior.
- [Token accounts](reference/token-accounts.md): where tokens live and how delegation works.
- [Settlement recovery](reference/settlement-recovery.md): resolve the original payment after an uncertain response.

## Project status

- [Product scope](scope.md) defines the product and its boundaries.
- [Implementation status](project/implementation-status.md) distinguishes code, regression tests, and accepted Devnet settlement.
- [Dependency advisories](project/dependency-advisories.md) records existing dependency risks.
- [Documentation maintenance](project/documentation.md) records the document map and update rules.

These guides describe the code in this branch. A running hosted service may
use a different revision. Health checks establish reachability, not payment
acceptance. Older proposals and code explanations are retained in the
[historical archive](archive/README.md); they are not setup instructions.
