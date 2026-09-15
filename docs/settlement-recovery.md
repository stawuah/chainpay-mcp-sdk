# Settlement recovery

All recovery uses the original authenticated owner, intent, invoice and signature. A status read never signs or broadcasts. Confirmed payment means a finalized transaction **and** a matching receipt. Merchant delivery is a separate x402 continuation.

## Browser and MCP

- Keep `payment_id` / `transaction_id` after a timeout. MCP returns the deterministic payment ID even when the Axum response is lost. `wait_for_payment` reads the existing operation.
- The browser stores public signed transaction bytes and operation references, never wallet private keys or session tokens. Its recovery card survives reloads. “Check settlement” updates the original waiting form/inbox and refreshes the dashboard; completed history is capped at 30 and dismissible.
- An unavailable/404 status is not proof that the request never arrived. “Cancel only if unstarted” calls `POST /v1/operations/cancel-unstarted` with `{kind:"payments"|"transactions",key:<original unscoped key>}`. An atomic cancellation reservation prevents a delayed request from starting. Cancellation fails if any operation reservation exists. Never clear an uncertain reservation manually.
- “Retry same signed approval” calls `POST /v1/payments/{id}/recover` or `/v1/transactions/{id}/recover` with `{signed_transaction:<original base64>,resubmit:true}`. The backend verifies the original canonical message, signature, complete transaction, current owner/connection scope and current mandate binding. It first reconciles status; a send is allowed only when signature status is absent and the original blockhash remains valid. Only identical signed bytes can be rebroadcast. There are no automatic HTTP retries for `sendTransaction`.
- An expired original blockhash is not permission to sign another transfer. Preserve the operation and query archival signature/receipt evidence. If evidence remains unavailable, the operation stays unresolved; pause/revoke remains available.
- To resume merchant delivery after settlement, call `execute_x402_payment` with `{paymentId:<existing backend payment_id>}`. It loads the original stored resource and challenge, checks the receipt, and retries that resource with proof. It performs no new preparation, signing or payment submission. Connection permissions and the merchant origin allowlist still apply.

## Provider signing interrupted before signature storage

1. Record the existing operation ID, original immutable message hash, approved agent and provider request/audit reference. Do not call the signing API again.
2. Obtain the original signed transaction from the authenticated provider audit response or the original signer runtime. If unavailable, retain the unresolved operation and escalate that specific request to provider support.
3. As the original owner (or permitted connection), call the payment recovery endpoint with `{signed_transaction:<recovered original bytes>,resubmit:false}`. The backend cryptographically verifies the signature and exact original message and attaches only that signature, then reconciles chain status. This does not send a transaction.
4. If submission is still required, use the explicit same-approval retry described above. Changed signatures/messages/agents are rejected. No database override can substitute for chain evidence.

## Provider wallet enrollment response lost

Repeat the original signed enrollment request to `/v1/managed-signers/provision`. Axum uses its server-side Privy credentials to GET the wallet by the original `ext_wal_<external_id>` identity. It checks returned external ID, Solana address, chain and required policy before attaching the existing wallet record.

A provider 404 permits an explicit retry of creation with **the identical external ID**, never a new identity. Privy guarantees external IDs are immutable and unique per app, so a delayed original creation and its retry cannot create two wallets. Other lookup failures remain uncertain. If creation's response is ambiguous, Axum attempts only a lookup; the owner can repeat the same enrollment later. This also recovers a crash after the local enrollment reservation but before the provider received the create request.

The provider evidence contract is documented in [Privy external IDs](https://docs.privy.io/wallets/wallets/external-ids) and [Get wallet](https://docs.privy.io/api-reference/wallets/get). No client receives provider credentials.

## Legacy rows and rollout

Historical idempotency keys are caller-controlled and do not establish owner identity. Migration 0007 performs no owner backfill. Legacy payment reads verify the on-chain owner; generic transaction reads require the trusted PR01 `transaction-owner` mapping. Legacy IDs without authenticated immutable intent claims cannot execute again.

Apply additive migrations only through the reviewed deployment process; do not run old and new submission workers concurrently during rollout. This change was tested only against isolated local PostgreSQL and mocked RPC/provider services. Never delete a claim, rewrite an intent, or force a success status to recover an uncertain payment.
