# ChainPay settlement networks

ChainPay keeps the authority and legacy bootstrap list on the protocol `config`
PDA, while the scalable settlement allowlist lives in one `asset` PDA per mint.
Every asset entry binds the mint to the classic SPL Token program or Token-2022.

## Devnet

The bootstrap command uses Circle's Devnet USDC mint:

`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

It initializes the ChainPay config with that mint, registers it in the asset
registry, registers the official Devnet PYUSD Token-2022 mint, and verifies
both assets. Run the real setup with:

```sh
CHAINPAY_KEYPAIR=/absolute/path/to/devnet-authority.json npm run bootstrap:devnet
```

The command is idempotent and simulates every transaction before submission.
The default Devnet PYUSD mint is:

`CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`

Use `CHAINPAY_TOKEN_2022_MINT` to override it with another existing mint.

The settlement smoke tests cover both a classic SPL Token mint and a basic
Token-2022 mint. Any valid mint can use the same path after its config authority
registers it; a payment still requires a user mandate for that exact mint and
the supplied source and recipient token accounts must belong to the same token
program.

## Production targets

The target production assets from the ChainPay scope are:

| Asset | Mainnet mint | Token program |
| --- | --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | classic SPL Token |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 |

The mint and token-program mapping must be verified again for every deployment
cluster before registering an asset. The scope calls this asset
`PYUSD`; `pyusdc` is not a separate ChainPay asset.

ChainPay currently supports the basic `transfer_checked` path. A mandate
authorizes the agent, mint, limits, and expiry; the destination is supplied for
each payment and the program transfers only to that supplied token account.
Token-2022 transfer hooks can supply their required remaining accounts through
the SDK and MCP payment request. Confidential transfers are not compatible with
this plaintext delegated `transfer_checked` path and need a separate settlement
flow.
