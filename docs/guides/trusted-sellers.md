# Trusted seller public configuration

A response-served statement is an optional off-chain seller signature. It
never replaces Paid. The signing secret stays on the merchant host; this
relay only stores and republishes **public** identities.

Compare the signing key with the configured seller identity. Do not treat a
recipient token account (ATA) as the seller.

## Environment

Cluster is always `devnet` for this MVP. `programId` defaults to the ChainPay
program when omitted from the convenience pair.

JSON array (`CHAINPAY_TRUSTED_SELLERS`):

```json
[
  {
    "cluster": "devnet",
    "programId": "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4",
    "sellers": ["GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"],
    "recipientTokenAccount": "RecipientTokenAccount11111111111111111111111"
  }
]
```

Single mapping:

```bash
CHAINPAY_CLUSTER=devnet
CHAINPAY_PROGRAM_ID=3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4
CHAINPAY_TRUSTED_SELLER=GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
CHAINPAY_TRUSTED_SELLER_RECIPIENT=RecipientTokenAccount11111111111111111111111
```

`GmaDrpp…` above is the SDK cross-language **fixture** seller, not a live
merchant key. Replace both public keys with the real seller identity and the
receipt recipient token account before enabling ingestion.

`GET /v1/config` repeats these public fields. It never includes a private key.

## Routes

- `POST /v1/delivery-attestations` — signed `{payload,signature}` from a
  configured seller, after the relay confirms a program-owned settled receipt
  PDA whose recipient matches the mapping.
- `GET /v1/delivery-attestations/{receiptAddress}` — public minimal DTO
  (`payload`, `signature`, `publishedAt`). Missing or invalid statements leave
  Paid unchanged.

Do not put live signing secrets, wallet seed phrases, or RPC credentials in
this file, git, or frontend environment variables.
