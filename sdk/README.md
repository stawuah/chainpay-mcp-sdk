# ChainPay SDK

The SDK is the user and agent-facing boundary for mandate creation, payment
request preparation, and receipt retrieval on Solana Devnet.

It must never receive or persist a user's private key. On-chain policy remains
the authority for every payment.

## Client capabilities

`ChainPayClient` provides the complete protocol-facing surface:

- derive config, mandate, and receipt PDAs;
- read and validate config, mandate, and receipt account data;
- detect classic SPL Token versus Token-2022 accounts;
- derive associated token accounts and prepare ATA creation instructions;
- build mandate creation plus limited delegate approval;
- build update, pause, revoke, and delegate-revoke transactions;
- prepare payment transactions with local policy preflight;
- detect duplicate invoice receipts before submission;
- simulate and execute through an injected signing/submission adapter.

The SDK returns transaction plans. Wallets or approved signer services remain
responsible for signing. It never accepts a keypair or seed phrase.

Example:

```ts
import { ChainPayClient } from "@chainpay/sdk";

const chainpay = new ChainPayClient({
  rpcUrl: "https://api.devnet.solana.com",
});

const prepared = await chainpay.preparePayment({
  mandate,
  invoiceHash,
  paymentId,
  signatureReference,
  mint,
  recipient,
  amount: 1_000_000n,
}, approvedAgent);

if (!prepared.preflight.valid) {
  throw new Error("Payment rejected by local preflight");
}
```
