# Register a stablecoin

ChainPay settles a curated set of tokens. Two things have to be true before an
owner can create a spending permission in one, and they are separate:

1. **The protocol authority has enabled it on chain.** `register_asset` creates
   one account per mint at `["asset", mint]`; `set_asset_status` turns it on or
   off later. Every payment carries that account and is rejected unless it is
   enabled, so disabling a mint stops new payments in it immediately without
   touching anyone's mandates.
2. **The dashboard can name it.** `frontend/src/owner/knownAssets.ts` maps a mint
   to a label and a sort position.

Only the first decides whether an asset can be paid. A mint that is enabled on
chain but absent from the table still works; it is labelled by its address.

## Enabled on Devnet

| Asset | Devnet mint | Token program | Decimals |
| --- | --- | --- | --- |
| USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | SPL Token | 6 |
| PYUSD | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` | Token-2022 | 6 |

## Named and awaiting authority registration

These are verified Devnet mints. The dashboard names them; the protocol
authority has not yet enabled them, so they will not appear in the stablecoin
list until it does.

| Asset | Devnet mint | Token program | Decimals |
| --- | --- | --- | --- |
| EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | SPL Token | 6 |
| USDG | `4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7` | Token-2022 | 6 |

Each was read from Devnet before being added: an initialized mint account, six
decimals, EURC a plain 82-byte SPL mint and USDG a 869-byte Token-2022 mint
whose account-type byte marks it a mint rather than a token account.

Two mainnet addresses were deliberately **not** carried over. The mainnet USDT
mint is not a mint on Devnet — it resolves to an empty system-owned account. The
mainnet USDS mint resolves on Devnet to an unrelated nine-decimal token, which
must never be registered as USDS.

## Enabling one

From the dashboard, with the authority wallet connected: **Settings → Advanced →
Protocol administration**. Registration costs a small SOL rent deposit per mint
and is a wallet-signed transaction like any other.

Mainnet mints differ from Devnet mints for the same asset. Moving to mainnet
means registering again there, with the issuer's mainnet addresses.

## Before calling an asset supported

Enabling a mint is not evidence that a payment in it settles. For each newly
enabled asset, run one payment end to end and keep the evidence:

1. Prepare the owner's token account for that mint.
2. Create a spending permission in it, and approve it in the wallet.
3. Send one payment to a recipient wallet that is not your own.
4. Confirm a receipt account exists on chain and the public receipt page renders.
5. Record the transaction signature.

A payment that reaches a receipt has exercised the whole path: mandate policy,
the delegate allowance, the token program, the relay's transaction validation,
and receipt derivation.

Token-2022 assets deserve one extra check. A transfer fee makes the recipient
receive less than the amount the mandate recorded, and a transfer hook runs a
program ChainPay did not write. Neither PYUSD nor USDG currently configures a
fee or an active hook, but a mint's configuration can change after registration,
which is what `set_asset_status` is for.

## Artwork

`frontend/src/ui/TokenIcon.tsx` keys artwork by the asset's label, so one file
covers every cluster's mint. EURC and USDG have none yet and show the neutral
mark. Adding a logo means placing the issuer's own file in
`frontend/src/assets/brands/`, recording where it came from in
`dashboard-sources.md`, and adding one line to `artworkByLabel`.

A drawn stand-in is not an acceptable substitute. A wrong mark beside an amount
on a payment screen misidentifies the money being spent.
