# PR #90 assets: PayPal test guide and demo

- `paypal-test-guide.pdf`: setup checklist and the four tests to run against the PayPal sandbox.
- `paypal-demo.mp4` / `paypal-demo.gif`: the full cycle (quote, PayPal checkout, capture, delivery, buyer challenge, merchant refund, records, shared receipt) in 67 seconds.
- `shots/`: one frame per demo step.
- `record-demo.mjs`: how the demo was recorded. Copy into `frontend/test/` and run it against `npm --prefix frontend run dev:paypal`.

The demo uses the real PayPal workspace screens from PR #90. PayPal and the AI are simulated by a stand-in that answers with the same receipt shapes as `backend/src/paypal/observations.rs`, because the hosted service was not deployed when it was recorded. It is not evidence of a live sandbox payment.

This branch holds media only and is not meant to be merged.
