# ChainPay settlement networks

ChainPay keeps settlement mint configuration on the protocol `config` PDA.
This makes the network and asset selection explicit instead of baking a
mainnet address into a Devnet demo.

## Devnet

Use a custom demonstration mint for the end-to-end demo. The settlement smoke
tests cover both a classic SPL Token mint and a basic Token-2022 mint. Do not
assume the mainnet USDC or PYUSD mint exists on Devnet.

## Production targets

The target production assets from the ChainPay scope are:

| Asset | Mainnet mint | Token program |
| --- | --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | classic SPL Token |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 |

The mint and token-program mapping must be verified again for every deployment
cluster before initializing or updating `config`. The scope calls this asset
`PYUSD`; `pyusdc` is not a separate ChainPay asset.

ChainPay currently supports the basic `transfer_checked` path. Token-2022
transfer hooks, confidential transfers, and other extension-heavy mints need
separate account-resolution and policy work before they can be enabled.
