# Durable PayPal task state

The isolated store uses its own schema file, never `backend/migrations`. Both
the URL and PostgreSQL's actual `current_database()` must identify a dedicated
`chainpay_paypal_*` database. Its database role must have no access to existing
ChainPay data. Schema initialization uses a transaction/advisory lock so replicas
cannot race startup.

Task records bind immutable document inputs, hashes, offer version, exact price,
quote expiry and buyer identity. Stable create-request IDs are unique within the
authenticated workspace/principal. A repeated key returns the original task;
changed input conflicts. PostgreSQL row locks serialize short state changes.
Network calls must happen after that transaction commits, not while holding it.

Buyer approval binds the quote digest. An agent may prepare a quote, never approve
it. A merchant is scoped to its own workspace. Refund approval binds the capture,
failed units and exact amount. Unresolved work cannot be refunded automatically;
unknown refunds do not reduce the displayed final cost. The stored dispatch key
survives failures/restarts and is never reset by another click.

Operator-issued access grants carry principal, workspace, role and expiry. Only
a SHA-256 token hash is stored. Grants expire within seven days and can be revoked.
There is no unauthenticated grant-creation route or caller-supplied identity.
These grants are demo app identity, not PayPal account authentication or payment
approval. Judge grant rotation is an operator responsibility.

Only verified webhooks may enter the inbox. Duplicate IDs preserve original
content; conflicting bodies are rejected. The inbox is acknowledged only after
durable insertion. Processing can be retried separately; unprocessed rows survive
a crash. Rate windows are also durable across replicas.

Persistence tests require `PAYPAL_TEST_DATABASE_URL` pointing to an isolated
`chainpay_paypal_*` database. They test two independent pools, concurrent checkout
claims, duplicate/changed create requests, cross-workspace denial, reconnect,
token revocation and immutable webhook events. They do not use PayPal credentials.
