# Official network and token artwork

Retrieved 2026-09-15. No recoloring, cropping, tracing, outlines or logo shadows; rendering uses `object-fit: contain`. The SVGs are stored exactly as supplied. `pyusd.png` is the supplied raster resampled to display size and nothing else — see its entry below. Surrounding cards are ChainPay artwork. These marks describe network/token compatibility on Devnet, not endorsement or PayPal checkout support.

- `solana.svg`: https://solana.com/src/img/branding/solanaLogoMark.svg — linked by https://solana.com/branding . Preserve clearspace and original gradient.
- `usdc.svg`: `Token Logo/USDC Token.svg` from https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/Pressroom/brandkit/logo-downloads/usdc.zip — linked by https://www.circle.com/pressroom . Token mark displayed at least 32px high with clearspace.
- `pyusd.png`: https://mintcdn.com/paxos-0ac97319/Vwn6v0Q_snwFVgjM/images/pyusd_logo.png — embedded by issuer documentation https://docs.paxos.com/guides/stablecoin/pyusd .
  The supplied file is 513x512, 16-bit RGBA, 35.7 kB. It is displayed at 36px and
  44px (`.asset-mark` in landing.css), so shipping 513px at 16-bit sent roughly
  35 kB to draw a 44px mark. Stored here resampled to 176x175 (4x the largest
  display size, covering 3x-density screens with headroom) at 8-bit RGBA, 13.4 kB.
  Alpha is preserved. That is a resample only — the same operation the browser was
  performing at render time, done once at build time instead. No recolor, no crop,
  no trace. Re-fetch the URL above for the untouched original.

All trademarks belong to their respective owners. No generated or traced logos.
