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

## Wanted: EURC and USDG

Both are registered and enabled on Devnet. Neither has artwork here, so each
draws its currency glyph instead of a mark. A glyph states the unit; it does not
stand in for an issuer. Nothing is broken until these arrive.

- `eurc.svg` — Circle's own EURC token mark. Same brand kit that supplied
  `usdc.svg`: https://www.circle.com/pressroom
- `usdg.png` or `usdg.svg` — Paxos' own Global Dollar mark. Same documentation
  family that supplied `pyusd.png`: https://docs.paxos.com/guides/stablecoin/usdg

For each file:

1. Put it in this folder, unmodified. If it must be resampled, say so in its
   entry the way `pyusd.png` does, and change nothing else about the image.
2. Add an entry above with the exact source URL and the page that links it.
3. Add one line to `artworkByLabel` in `frontend/src/ui/TokenIcon.tsx`, keyed by
   the label (`EURC`, `USDG`), not by a mint. One file covers every cluster.

That is the whole change. The glyph disappears on its own once the label has
artwork.

All trademarks belong to their respective owners. No generated or traced logos.

## Official wallet artwork · 2026-09-15

Unmodified vendor SVG originals, used to identify wallet choices and official download links. Discovery artwork does not establish that the wallet is installed, supports ChainPay's Devnet signing flow, or endorses ChainPay. Connected wallet rows should prefer the icon supplied by Wallet Standard. Preserve original colors and proportions.

- `phantom.svg`: `Nov 2024/Phantom App Icon/phantom-app-icon-drkprpl.svg` extracted from the [official press kit](https://sanity-proxy-v2.phantom.app/files/3nm6d03a/production/5e73f0ad2d621b5ed6ca3c66aad2b70686f8a00e.zip), linked in the [Phantom homepage](https://phantom.com/) footer. Download destination: https://phantom.com/download .
- `solflare.svg`: https://www.solflare.com/wp-content/uploads/2024/11/App-Icon.svg , linked as the wallet logo on the [official homepage](https://www.solflare.com/). The homepage also links the [official brand kit](https://www.solflare.com/solflare-brand-kit.zip). Installation destination: https://www.solflare.com/ (vendor extension/mobile choices).
- `jupiter.svg`: https://jup.ag/svg/jupiter-logo.svg , linked as the logo on [Jupiter Mobile](https://jup.ag/mobile). Download destination: https://jup.ag/mobile . This is Jupiter's published mark, not an assertion of a tested ChainPay wallet connection.
- `metamask.svg`: https://metamask.io/assets/images/fox/default.svg , linked as MetaMask artwork on the [official homepage](https://metamask.io/). Download destination: https://metamask.io/download/ .

All four parse as SVG XML; none contains a script or foreignObject. Do not inline provider-supplied SVG markup: render icon URLs through an image element.
