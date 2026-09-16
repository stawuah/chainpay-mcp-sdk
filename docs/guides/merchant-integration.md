# Accept payment for a resource

ChainPay's demo merchant shows how to gate an HTTP resource on a verified
Devnet payment. **Start with the [merchant setup](../../demo-merchant/README.md).**
It lists the required public accounts, environment, and startup command.

## The request flow

1. A client requests the resource. The merchant responds with HTTP **402** and
   a ChainPay payment challenge.
2. The client verifies the challenge and checks an approved mandate. The
   owner wallet or configured external signer signs the payment transaction.
3. ChainPay settles on Devnet and creates a receipt. The client retries the
   original resource with `{signature, receiptPDA}` proof.
4. The merchant independently verifies the finalized transaction and receipt
   against its expected payment before releasing the resource.

HTTP 200 alone is not settlement evidence. Keep the receipt, signature,
original challenge, and returned resource when running an acceptance test.

## Protocol compatibility

This is ChainPay's custom `x402/1.0` receipt-proof flow: `network` is
`solana-devnet` and `payTo` names a **recipient token account**. It is not the
standard x402 v2 sponsored SVM flow. The agent adapter recognizes that other
protocol and rejects it before signing; it does not operate a facilitator.

## Identity and delivery

Configure the MCP server to trust the exact merchant origin before it fetches
resources. Production fetches require HTTPS; local development can explicitly
allow loopback HTTP. Redirects remain blocked.

The merchant can optionally publish a signed response-served statement.
Follow [trusted seller configuration](trusted-sellers.md) to bind the seller
identity to the receipt's recipient account. A seller signing key is not a
settlement key and must remain on the merchant host.

The payment remains Paid regardless of whether optional delivery evidence is
available. See [receipt semantics](../reference/receipts.md) and
[payment recovery](../reference/settlement-recovery.md) before implementing retries.
