# PayPal allowances demo

Recorded against the real workspace UI on `dre/paypal-allowances`. PayPal and the API are simulated by a stateful stand-in inside `record-demo.mjs` (ported from `frontend/test/fixtures/paypal-allowances.tsx`: same seed catalog, same nine-rule order, same response shapes). Not a live run and not payment evidence.

## Files

- `paypal-allowances-demo.mp4` — 1440x900, 2:19, captions on every step
- `paypal-allowances-demo.gif` — 960 px wide, 4 fps, under 15 MB
- `shots/NN-name.png` — one 1440-wide screenshot per step (31)
- `mobile/NN-name.png` — 390-wide full-page screenshots: allowances builder, approvals inbox, receipt with purchase section, marketplace quote, disputes table
- `record-demo.mjs` — the recorder
- `video/` — raw Playwright webm

## Rerun

```
cd frontend && VITE_CHAINPAY_PAYPAL=true VITE_CHAINPAY_PAYPAL_API_ORIGIN=http://127.0.0.1:8081 npm run dev:paypal
cd /home/claude/demo-allowances && node record-demo.mjs /home/claude/demo-allowances
ffmpeg -i video/*.webm -c:v libx264 -crf 22 -pix_fmt yuv420p paypal-allowances-demo.mp4
```

`node_modules` is a symlink to the preinstalled Playwright. Access codes: `demo-buyer-code`, `demo-agent-code`, `demo-merchant-code`.

## Steps

1. Buyer signs in with an access code and opens Allowances.
2. Builds "Weekend errands": $120 total, $40 per purchase, Corner Grocer + Riverside Box Office, Agent pays, PayPal sandbox, cooldown 0. The blue card rewrites while the caps are typed. Create → `Continue PayPal approval` → simulated PayPal page → back with `?allowance=` → vault `ready`, allowance `Active`.
3. Agent signs in. Allowances shows the rules with no vault or payment details. Marketplace: Corner Grocer, Oat milk ×2 + Coffee beans 250g ×1 = $20.30 → quote Allowed → Buy now → receipt `PayPal capture confirmed`, sidebar `Captured`.
4. Agent tries Riverside Box Office, Evening show ticket ×2 = $64.00 under Weekend errands → `per_purchase_cap` (Over the per-purchase cap). Switches to "Show tickets" (Ask me first, $100 per purchase) → Allowed → Buy now → `Approval requested`.
5. Buyer: `Waiting for you (1)` → Approve $64.00 → receipt captured. Agent tab (picture-in-picture) has a grocery quote open under Weekend errands: Allowed. Buyer pauses Weekend errands → agent's next quote: `allowance_not_active`.
6. Merchant opens the grocery receipt: Fulfil unit 1, Fulfil unit 2, Mark unit 3 failed. Agent: Request refund for failed units ($12.50, unit 3). Merchant: Approve $12.50 refund → `Refund confirmed`, net $7.80.
7. Merchant Disputes: Sync from PayPal → one case on the ticket capture, `WAITING_FOR_SELLER_RESPONSE` / `INQUIRY` → Preview evidence pack → Submit evidence pack → `Submitted` → the ticket receipt shows the dispute pill.
8. Buyer: Share redacted receipt → public receipt page without sign-in.

The step-5 "agent tab" is a second Playwright context signed in as the agent; its screenshots are overlaid on the recorded tab so the pause and the refusal appear in one video.
