# Devnet bootstrap

`bootstrap-devnet.mjs` performs the real, idempotent ChainPay Devnet setup:

1. verifies the deployed ChainPay program and Devnet USDC mint;
2. initializes the config PDA with Devnet USDC when it does not exist;
3. registers Devnet USDC in the asset registry;
4. verifies the official Solana Devnet PYUSD Token-2022 mint; and
5. registers and verifies that Token-2022 mint.

Every transaction is simulated first. A transaction is only submitted after
simulation succeeds. The script requires an explicit signer path and never
creates, prints, or stores a private key in the repository.

Run it with a funded Devnet authority:

```sh
CHAINPAY_KEYPAIR=/absolute/path/to/devnet-authority.json npm run bootstrap:devnet
```

Optional environment variables:

- `CHAINPAY_RPC_URL` — Devnet RPC URL; defaults to `https://api.devnet.solana.com`.
- `CHAINPAY_PROGRAM_ID` — deployed ChainPay program; defaults to the current Devnet program.
- `CHAINPAY_TOKEN_2022_MINT` — override the default Devnet PYUSD Token-2022 mint
  with another existing Token-2022 mint.

The default Devnet PYUSD mint is
`CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`. The mint is registered only
after its account owner is verified as Token-2022.

The scalable registry is one PDA per mint, so any valid classic SPL Token or
Token-2022 mint can be enabled by the config authority. Basic Token-2022
transfers are supported by the settlement program; extension-specific mints
that require extra accounts need those accounts supplied to the payment
instruction.
