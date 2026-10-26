from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Image,
                                Table, TableStyle, PageBreak, KeepTogether)
from PIL import Image as PILImage

FONTS = "/home/claude/chainpay-mcp-sdk/frontend/public/fonts"
pdfmetrics.registerFont(TTFont("Inter", f"{FONTS}/inter-400.ttf"))
pdfmetrics.registerFont(TTFont("Inter-Medium", f"{FONTS}/inter-500.ttf"))
pdfmetrics.registerFont(TTFont("Inter-Semi", f"{FONTS}/inter-600.ttf"))
pdfmetrics.registerFontFamily("Inter", normal="Inter", bold="Inter-Semi", italic="Inter", boldItalic="Inter-Semi")

BLUE = colors.HexColor("#0052ff")
INK = colors.HexColor("#14213d")
INK2 = colors.HexColor("#56647d")
LINE = colors.HexColor("#e3e8f2")
SOFT = colors.HexColor("#eef3ff")
WARN = colors.HexColor("#fff4e0")
WARN_INK = colors.HexColor("#8a5a00")
OUT = "/home/claude/demo-allowances"
SHOTS = f"{OUT}/shots"
BRANCH = "dre/paypal-allowances"

body = ParagraphStyle("body", fontName="Inter", fontSize=9.6, leading=14, textColor=INK)
small = ParagraphStyle("small", parent=body, fontSize=8.5, leading=12, textColor=INK2)
h1 = ParagraphStyle("h1", fontName="Inter-Semi", fontSize=26, leading=31, textColor=INK, spaceAfter=6)
h2 = ParagraphStyle("h2", fontName="Inter-Semi", fontSize=16, leading=21, textColor=INK, spaceBefore=6, spaceAfter=8, keepWithNext=1)
h3 = ParagraphStyle("h3", fontName="Inter-Semi", fontSize=11.5, leading=16, textColor=INK, spaceBefore=4, spaceAfter=4, keepWithNext=1)
eyebrow = ParagraphStyle("eyebrow", fontName="Inter-Semi", fontSize=8.5, leading=11, textColor=BLUE)
code = ParagraphStyle("code", fontName="Courier", fontSize=7.6, leading=11, textColor=INK)
cell = ParagraphStyle("cell", parent=body, fontSize=9, leading=13)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Inter-Semi")
chat_you = ParagraphStyle("chat_you", parent=cell, fontName="Inter-Semi", textColor=BLUE)


def P(text, style=body):
    return Paragraph(text, style)


def C(text):
    return f'<font name="Courier">{text}</font>'


def callout(text, bg=SOFT, ink=INK):
    t = Table([[Paragraph(text, ParagraphStyle("c", parent=body, textColor=ink))]], colWidths=[170 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("BOX", (0, 0), (-1, -1), 0, bg),
                           ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                           ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    return t


def codeblock(lines):
    t = Table([[Paragraph(l.replace(" ", "&nbsp;"), code)] for l in lines], colWidths=[170 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f4f6fa")),
                           ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 1.5),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5)]))
    return t


def shot(name, caption, width=150 * mm):
    path = f"{SHOTS}/{name}.png"
    w, h = PILImage.open(path).size
    img = Image(path, width=width, height=width * h / w)
    framed = Table([[img]], colWidths=[width])
    framed.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    return KeepTogether([framed, Spacer(1, 3), P(f"shots/{name}.png. {caption}", small), Spacer(1, 10)])


def shots2(a, cap_a, b, cap_b, width=78 * mm):
    # Two screenshots on one row so a step fits on a page with its table.
    def framed(name):
        path = f"{SHOTS}/{name}.png"
        w, h = PILImage.open(path).size
        return Image(path, width=width, height=width * h / w)
    t = Table([[framed(a), framed(b)], [P(f"shots/{a}.png. {cap_a}", small), P(f"shots/{b}.png. {cap_b}", small)]],
              colWidths=[width + 3 * mm, width + 3 * mm])
    t.setStyle(TableStyle([("BOX", (0, 0), (0, 0), 0.6, LINE), ("BOX", (1, 0), (1, 0), 0.6, LINE),
                           ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm), ("TOPPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, 0), 3), ("BOTTOMPADDING", (0, 1), (-1, 1), 8)]))
    return KeepTogether([t])


def two_col(rows, widths=(52 * mm, 118 * mm), header=None, pad=5):
    data = []
    if header:
        data.append([P(header[0], cellb), P(header[1], cellb)])
    data += [[P(a, cellb), P(b, cell)] for a, b in rows]
    t = Table(data, colWidths=list(widths), repeatRows=1 if header else 0)
    style = [("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad)]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), SOFT))
    t.setStyle(TableStyle(style))
    return t


def steps_table(rows):
    data = [[P("#", cellb), P("Do this", cellb), P("You should see", cellb)]]
    for i, (do, see) in enumerate(rows, 1):
        data.append([P(str(i), cell), P(do, cell), P(see, cell)])
    t = Table(data, colWidths=[8 * mm, 78 * mm, 84 * mm], repeatRows=1)
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 0), (-1, 0), SOFT),
                           ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 5),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    return t


def check_table(rows):
    data = [[P("Check", cellb), P("How", cellb), P("Pass when", cellb)]]
    data += [[P(a, cell), P(b, cell), P(c, cell)] for a, b, c in rows]
    t = Table(data, colWidths=[40 * mm, 70 * mm, 60 * mm], repeatRows=1)
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 0), (-1, 0), SOFT),
                           ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 5),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    return t


def chat(turns):
    # A short MCP exchange: who speaks, then what was said or returned.
    data = [[P(who, chat_you if who == "User" else cellb), P(text, cell)] for who, text in turns]
    t = Table(data, colWidths=[22 * mm, 148 * mm])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    return t


def chrome(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BLUE)
    canvas.rect(0, A4[1] - 6, A4[0], 6, fill=1, stroke=0)
    canvas.setFont("Inter", 8)
    canvas.setFillColor(INK2)
    canvas.drawString(20 * mm, 12 * mm, f"ChainPay · PayPal allowances test guide · {BRANCH}")
    canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, f"{doc.page}")
    canvas.restoreState()


doc = BaseDocTemplate(f"{OUT}/paypal-allowances-guide.pdf", pagesize=A4, title="ChainPay PayPal allowances test guide",
                      author="ChainPay", leftMargin=20 * mm, rightMargin=20 * mm, topMargin=20 * mm, bottomMargin=22 * mm)
doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(20 * mm, 22 * mm, 170 * mm, A4[1] - 42 * mm, id="f")], onPage=chrome)])

s = []

# 1. What this PR adds
s += [Image("/home/claude/chainpay-mcp-sdk/frontend/public/brand/chainpay-icon-192.png", width=14 * mm, height=14 * mm, hAlign="LEFT"), Spacer(1, 10)]
s += [P(f"BRANCH {BRANCH.upper()} · PAYPAL SANDBOX ONLY", eyebrow), Spacer(1, 4), P("PayPal allowances: what to test", h1)]
s += [P("A buyer gives an agent a spending allowance backed by a saved PayPal payment method, the agent buys from a small seeded marketplace inside it, "
        "and the merchant answers a PayPal dispute with the stored record. Nothing here changes the Colosseum relay, the Solana MCP tools or the website."), Spacer(1, 4),
      P("Watch first: <b>paypal-allowances-demo.mp4</b> (2:08) in the demo folder shows the whole cycle in the real workspace UI with PayPal and the API simulated. "
        "It is not payment evidence. The steps in this guide use the real backend and the PayPal sandbox.", small), Spacer(1, 6)]
s += [P("Three things are new", h3)]
s += [two_col([
    ("Allowances", "A buyer sets a name, total cap, per-purchase cap, merchants, an optional agent, purchases per day, a cooldown and an expiry, then saves a PayPal method "
                   "for it (a vault token that never leaves the server). Two modes: <b>Agent pays</b> charges at purchase time; <b>Ask me first</b> files a request the buyer "
                   "approves or denies from an inbox, and charges on approval. Every quote and purchase runs the same nine rules in the same order (status, expiry, agent, "
                   "merchant, per-purchase cap, total cap, max per day, cooldown, vault); the first failing rule names the " + C("reason_code") + "."),
    ("Marketplace", "Four seeded merchants with fixed prices in cents. A basket is quoted against an allowance before anything is bought. A captured purchase is a task "
                    "receipt with one unit per item: the merchant fulfils or fails each one and the agent can ask for a refund of exactly the failed ones."),
    ("Dispute evidence", "The merchant syncs open PayPal disputes on captured purchases, previews an evidence pack built only from the stored record (rule checks, "
                         "who approved, delivery per unit, refunds, digests) and submits it once. PayPal decides the outcome."),
], widths=(32 * mm, 138 * mm)), Spacer(1, 8)]
s += [P("How it sits beside the document service", h3),
      P("The existing PayPal service (quote a document job, pay by checkout, deliver, accept or challenge, refund) is untouched. Allowances reuse its pieces: the same "
        "access codes and roles, the same task record and receipt page, the same per-unit fulfilment and refund path, the same webhook inbox and share link. A purchase is "
        "a task whose receipt carries a " + C("purchase") + " block and whose units have a price instead of a document hash. "
        "The new write routes sit behind one flag, " + C("CHAINPAY_PAYPAL_ALLOWANCES") + "; with it off the service behaves as before.")]
s += [Spacer(1, 6), P("The cycle at a glance", h3)]
glance = [["1. Set caps", "Buyer builds an allowance and saves a PayPal method for it. Nothing charged."],
          ["2. Quote", "Agent prices a basket against the allowance. The verdict lists all nine rules."],
          ["3. Buy or ask", "Agent pays (charged now) or requests approval (buyer decides in the inbox)."],
          ["4. Fulfil", "Merchant marks each unit delivered or failed. The record keeps both."],
          ["5. Refund", "Agent requests a refund for the failed units; a merchant approves it."],
          ["6. Dispute", "Merchant syncs PayPal disputes and submits the evidence pack once."],
          ["7. Share", "Buyer shares a redacted receipt that opens without signing in."]]
s += [two_col(glance, widths=(28 * mm, 142 * mm), pad=3)]
s += [PageBreak()]

# 2. Run it locally
s += [P("SETUP", eyebrow), P("Run it locally", h2)]
s += [P("You need Postgres, Rust, Node 20+, a PayPal sandbox REST app (client id and secret) and an OpenRouter key with a spend cap. "
        "Full notes are in <b>deploy/paypal/README.md</b>; " + C("deploy/paypal/.env.example") + " is the checklist for a fresh environment. "
        "Rust reads exported variables, not the file. Never reuse the relay's environment or database."), Spacer(1, 6)]
s += [P("Backend", h3), codeblock(["cargo run -p chainpay-backend --features paypal --bin chainpay-paypal"]), Spacer(1, 6)]
s += [two_col([
    (C("CHAINPAY_PAYPAL_ENABLED"), C("true") + ". Off, the service answers 503 on /healthz and has no payment routes."),
    (C("CHAINPAY_PAYPAL_NEW_PURCHASES"), C("true") + " for the test. Off, checkout and allowance purchases are refused; reads and recovery still work."),
    (C("CHAINPAY_PAYPAL_ALLOWANCES"), C("true") + ". Gates " + C("POST /allowances") + " and " + C("POST /purchases") + ". Reads, approvals, fulfilment and dispute routes stay available when it is off."),
    (C("CHAINPAY_PAYPAL_DATABASE_URL"), "A separate database whose name starts " + C("chainpay_paypal_") + ". " + C("DATABASE_URL") + " is never a fallback."),
    (C("CHAINPAY_PAYPAL_PUBLIC_ORIGIN"), "The workspace origin, " + C("http://localhost:5197") + " for the Vite dev server. PayPal returns the buyer here after approving the vault."),
    (C("CHAINPAY_PAYPAL_HOST") + ", " + C("PORT"), C("127.0.0.1") + " and " + C("8081") + "; the frontend expects the API on 8081."),
    (C("PAYPAL_API_BASE"), C("https://api-m.sandbox.paypal.com") + ". Only the sandbox origin is accepted."),
    (C("PAYPAL_CLIENT_ID") + ", " + C("PAYPAL_CLIENT_SECRET"), "The sandbox REST app. The app needs the <b>Vault</b> feature for PayPal wallet vaulting and the <b>Disputes</b> feature for sync."),
    (C("PAYPAL_WEBHOOK_ID"), "The id of the webhook registered on that app (next section)."),
    (C("CHAINPAY_PAYPAL_AI_KEY"), "A dedicated OpenRouter key. The allowance path never calls it, but startup requires it."),
    (C("CHAINPAY_PAYPAL_SUBSCRIPTIONS"), C("false") + " for this test."),
], widths=(66 * mm, 104 * mm)), Spacer(1, 8)]
s += [P("Webhooks to register on the sandbox app", h3),
      P("Point the webhook at " + C("<public origin>/v1/paypal/webhooks") + " (use a tunnel such as ngrok for a local run) and subscribe to the order and capture events "
        "the document service already uses (" + C("CHECKOUT.ORDER.APPROVED") + ", " + C("CHECKOUT.ORDER.COMPLETED") + ", " + C("PAYMENT.CAPTURE.COMPLETED") + ", "
        + C("PAYMENT.CAPTURE.DENIED") + ", " + C("PAYMENT.CAPTURE.REVERSED") + ", " + C("PAYMENT.CAPTURE.REFUNDED") + ", " + C("PAYMENT.REFUND.PENDING") + ", "
        + C("PAYMENT.REFUND.COMPLETED") + ") plus the six this branch adds:"), Spacer(1, 4)]
s += [codeblock(["VAULT.PAYMENT-TOKEN.CREATED   VAULT.PAYMENT-TOKEN.DELETED   VAULT.PAYMENT-TOKEN.DELETION-INITIATED",
                 "CUSTOMER.DISPUTE.CREATED      CUSTOMER.DISPUTE.UPDATED      CUSTOMER.DISPUTE.RESOLVED"]), Spacer(1, 4)]
s += [P("A deleted vault token puts the allowance's payment method back to not ready, so the next quote fails on the " + C("vault")
        + " rule. A dispute event only marks a capture the service already knows; everything else stays in the inbox.", small), Spacer(1, 8)]
s += [P("Access codes", h3),
      P("Issue three grants in one workspace from a shell that has the backend variables loaded. The agent shares the buyer's principal; "
        "the merchant is its own. Each prints a 64-character code: treat them like passwords and keep them out of logs and recordings."), Spacer(1, 4)]
s += [codeblock(["cargo run -p chainpay-backend --features paypal --bin chainpay-paypal -- issue-access test-ws test-buyer buyer",
                 "cargo run -p chainpay-backend --features paypal --bin chainpay-paypal -- issue-access test-ws test-buyer agent",
                 "cargo run -p chainpay-backend --features paypal --bin chainpay-paypal -- issue-access test-ws test-merchant merchant"]), Spacer(1, 8)]
s += [P("Frontend", h3), codeblock(["cd frontend",
                                    "VITE_CHAINPAY_PAYPAL=true VITE_CHAINPAY_PAYPAL_API_ORIGIN=http://127.0.0.1:8081 npm run dev:paypal"]),
      Spacer(1, 4), P("Open " + C("http://127.0.0.1:5197/paypal/") + ". Use a separate browser profile or private window per role; signing out clears only the current tab.", small)]
s += [Spacer(1, 10)]

s += [P("SETUP", eyebrow), P("Check the sandbox app first", h2)]
s += [P("Two PayPal features have to be switched on for the app before the walkthrough works, and the error you get later is not obvious. "
        "This script asks PayPal directly. It uses the secret for the token call only and never prints it."), Spacer(1, 4)]
s += [codeblock(["PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-sandbox-check.mjs"]), Spacer(1, 6)]
s += [P("What each line means", h3)]
s += [two_col([
    (C("token: ok"), "The client id and secret are a valid sandbox app. Anything else here means the credentials are wrong, not the features."),
    (C("vault setup token (paypal wallet): HTTP 201 status=PAYER_ACTION_REQUIRED") + "<br/>" + C("  approve link: https://www.sandbox.paypal.com/..."),
     "The app can vault a PayPal wallet. This is the link the buyer is sent to in walkthrough step 2."),
    (C("vault setup token (paypal wallet): HTTP 4xx") + "<br/>" + C("  error: NOT_AUTHORIZED ..."),
     "The Vault feature is not enabled on the app (Apps &amp; Credentials → the app → Features → Vault). Either enable it or choose <b>Sandbox card</b> as the payment method "
     "when building the allowance; the test card " + C("4111111111111111") + " with any future expiry works there."),
    (C("disputes api: HTTP 200 enabled"), "The merchant's <b>Sync from PayPal</b> will work."),
    (C("disputes api: HTTP 4xx not enabled (...)"), "The Disputes feature is off on the app. Sync answers with PayPal's error and the disputes table stays empty; "
                                                 "everything before step 7 still works."),
], widths=(78 * mm, 92 * mm)), Spacer(1, 10)]
s += [callout("<b>Health check:</b> " + C("GET http://127.0.0.1:8081/healthz") + " answers " + C('{"status":"ready"}') + " once enabled and the database answers. "
              "\"disabled\" means " + C("CHAINPAY_PAYPAL_ENABLED") + " is not exactly " + C("true") + "; \"unavailable\" means the database is unreachable. "
              "A ready health response proves configuration, not PayPal acceptance.")]
s += [Spacer(1, 10), P("What the walkthrough uses", h3),
      P("Two allowances. You create <b>Weekend errands</b> in step 2 ($120 total, $40 per purchase, Corner Grocer and Riverside Box Office, Agent pays, PayPal sandbox). "
        "Before step 4, create a second one as the buyer named <b>Show tickets</b>: Ask me first, Riverside Box Office only, $300 total, $100 per purchase, "
        "agent " + C("test-buyer") + ", and complete its PayPal approval too. The demo recording seeds this one; your run makes it by hand.")]
s += [PageBreak()]

# 3. Walkthrough
s += [P("WALKTHROUGH", eyebrow), P("Step 1 · Sign in and open Allowances (buyer)", h2)]
s += [steps_table([
    ("Open the workspace and paste the <b>buyer</b> access code. Click <b>Open workspace</b>.", "The view switcher: Work studio, Allowances, Marketplace, Outcome analytics. The header says <b>Buyer · test-ws</b>."),
    ("Click <b>Allowances</b>.", "\"Agent allowances\" with the <b>New allowance</b> form on the left and a blue allowance card on the right. Below it, <b>Waiting for you (0)</b> and no rows yet."),
])]
s += [Spacer(1, 8), shots2("01-sign-in", "The access-code sign-in.", "02-allowances", "The empty Allowances view for a buyer.")]

s += [P("Step 2 · Build \"Weekend errands\" and approve it on PayPal (buyer)", h2)]
s += [steps_table([
    ("Name <b>Weekend errands</b>, Total cap <b>120</b>, Per purchase cap <b>40</b>, Mode <b>Agent pays</b>, tick <b>Corner Grocer</b> and <b>Riverside Box Office</b>, "
     "leave Agent empty, Cooldown <b>0</b>, Max purchases per day <b>3</b>, Payment method <b>PayPal sandbox</b>.",
     "The card reads \"Any agent may pay up to $40.00 per purchase at Corner Grocer and Riverside Box Office, up to $120.00 in total, at most 3 times a day, until &lt;date&gt;.\""),
    ("Click <b>Create allowance</b>.", "A new row <b>Weekend errands</b> with status <b>Active</b>, \"Payment method not ready\" and a link <b>Continue PayPal approval</b>."),
    ("Click <b>Continue PayPal approval</b>. Log in with the sandbox <b>personal</b> account and agree to save the payment method.",
     "PayPal's own approval page for a saved payment method. Nothing is charged."),
    ("You are returned to the workspace with " + C("?allowance=") + " in the URL.", "The row now says <b>Payment method ready (PayPal sandbox)</b>. Spent $0.00, Remaining $120.00."),
])]
s += [Spacer(1, 8), shots2("03-builder-filled", "The filled form and the card it produces.", "06-allowance-ready", "Back from PayPal: the vault is ready and the allowance is Active.")]
s += [callout("If PayPal shows an error instead of the approval page, the app does not have the Vault feature. Revoke this allowance and create it again with "
              "<b>Sandbox card</b> as the payment method; the rest of the walkthrough is the same.", WARN, WARN_INK)]

s += [Spacer(1, 6), P("Step 3 · The agent buys groceries (agent)", h2)]
s += [steps_table([
    ("Sign out. Paste the <b>agent</b> code and open the workspace. Click <b>Allowances</b>.",
     "The agent sees <b>Weekend errands</b> with its caps and merchants, but no payment method, no vault status and no Pause or Revoke buttons."),
    ("Click <b>Marketplace</b>, pick <b>Corner Grocer</b>, add Oat milk 1L ×2 and Coffee beans 250g ×1. Pay with allowance: <b>Weekend errands</b>.",
     "Total <b>$20.30</b>. The quote pane says <b>Allowed by the allowance rules.</b> Open <b>Rule checks</b>: nine rows, every one \"allowed\" or \"within\"; "
     "the expiry row shows a date, the cooldown row \"no purchases yet\"."),
    ("Click <b>Buy now · $20.30</b>.", "The receipt opens with the status <b>PayPal capture confirmed</b>; the sidebar shows <b>3 items</b>, <b>$20.30 · Captured</b>, Corner Grocer. "
                                    "The purchase block lists the lines and the rule checks; each unit shows its price and is <b>Pending</b>."),
])]
s += [Spacer(1, 8), shots2("09-market-quote-allowed", "The grocery quote passes all nine rules.", "10-receipt-captured", "The receipt right after capture. Units carry a price, not a document hash.")]

s += [Spacer(1, 6), P("Step 4 · Over the cap, then an ask-first request (agent)", h2)]
s += [steps_table([
    ("Still in Marketplace: pick <b>Riverside Box Office</b>, add Evening show ticket ×2, keep <b>Weekend errands</b> selected.",
     "Total $64.00. The verdict is <b>Refused: Over the per-purchase cap.</b> with the code " + C("per_purchase_cap") + ". <b>Buy now</b> is disabled. "
     "In Rule checks, per_purchase_cap reads \"$64.00 of $40.00 · over\"."),
    ("Change the allowance to <b>Show tickets</b>.", "<b>Allowed by the allowance rules.</b> The button is now <b>Buy now · $64.00</b>."),
    ("Click it.", "A receipt with the status <b>Approval requested</b>. The sidebar shows <b>2 items</b>, <b>$64.00 · Approval requested</b>. "
                  "Nothing was charged: no capture id, Funding reads \"Waiting for the buyer\"."),
])]
s += [Spacer(1, 8), shots2("11-market-over-cap", "Refused on the per-purchase cap; the button stays off.", "13-receipt-approval-requested", "An ask-first purchase waits for the buyer. No capture exists yet.")]

s += [Spacer(1, 6), P("Step 5 · Approve, then pause (buyer)", h2)]
s += [steps_table([
    ("Sign out, sign in as the <b>buyer</b>, click <b>Allowances</b>.", "<b>Waiting for you (1)</b> with the $64.00 request from Riverside Box Office and two buttons, <b>Approve $64.00</b> and <b>Deny</b>."),
    ("Click <b>Approve $64.00</b>.", "The receipt opens with <b>PayPal capture confirmed</b>. The purchase block says \"Approved by test-buyer &lt;time&gt;\" and the rule checks were run again at approval time. "
                                  "Show tickets now shows Spent $64.00, Today 1 of 2."),
    ("In a second window signed in as the agent, open Marketplace, pick Corner Grocer, add Oat milk ×1 under Weekend errands.", "<b>Allowed by the allowance rules.</b>"),
    ("Back as the buyer, on the <b>Weekend errands</b> row click <b>Pause</b>.", "The pill reads <b>Paused</b>; the buttons become <b>Resume</b> and <b>Revoke</b>."),
    ("In the agent window change the basket (add one more Oat milk).", "<b>Refused: This allowance is not Active.</b> with the code " + C("allowance_not_active") + ". "
                                                                        "The status rule is the first row. Refresh the agent's Allowances view: Weekend errands is no longer listed."),
    ("Optional: as the buyer <b>Resume</b> it, then test a denial. Have the agent request $18.00 (Matinee ×1) under Show tickets and click <b>Deny</b> with a reason.",
     "The receipt says \"Denied by the buyer. Nothing was charged.\" and the rule checks gain a " + C("buyer_decision") + " row. If an allowance is paused between request and approval, "
     "approving it instead gives \"Denied by the allowance rules at approval time\" with " + C("approved_by") + " = " + C("rules") + "."),
])]
s += [Spacer(1, 8), shots2("14-inbox", "The buyer's inbox: one request, approve or deny.", "18-agent-not-active", "After the pause (buyer tab) the agent's next quote is refused (inset).")]

s += [Spacer(1, 6), P("Step 6 · Fulfil, fail a unit, refund (merchant and agent)", h2)]
s += [steps_table([
    ("Sign in as the <b>merchant</b>. Open the <b>$20.30</b> receipt from the sidebar.", "Three units, each with <b>Fulfil unit N</b> and <b>Mark unit N failed</b> buttons. The merchant has no Allowances or Marketplace view."),
    ("Click <b>Fulfil unit 1</b>, <b>Fulfil unit 2</b>, <b>Mark unit 3 failed</b>.", "The timeline reads <b>2 delivered · 1 failed</b>. Unit 3 (Coffee beans 250g, $12.50) shows <b>Failed</b>."),
    ("Sign in as the <b>agent</b>, open the same receipt, click <b>Request refund for failed units</b>.",
     "<b>Refund requested: $12.50 for unit 3.</b> A merchant must approve it. The agent has no approve button."),
    ("Sign in as the <b>merchant</b>, open the receipt, click <b>Approve $12.50 refund</b>.",
     "Within a few seconds the status is <b>Refund confirmed</b>. Net buyer cost <b>$7.80</b>: original quote $20.30, confirmed refund $12.50."),
])]
s += [Spacer(1, 8), shots2("20-merchant-fulfilled", "Delivered and failed units on one record.", "24-refund-confirmed", "After the refund: captured $20.30, refunded $12.50, net $7.80.")]

s += [Spacer(1, 6), P("Step 7 · A dispute on the ticket capture (merchant)", h2)]
s += [P("Raise the dispute at <b>sandbox.paypal.com</b> as the personal account that paid: Activity → the $64.00 payment → Report a problem → Item not received. "
        "Then, as the merchant:"), Spacer(1, 4)]
s += [steps_table([
    ("Click <b>Disputes</b>, then <b>Sync from PayPal</b>.", "One row: the dispute id, the task id, status <b>WAITING_FOR_SELLER_RESPONSE</b>, stage <b>INQUIRY</b>, "
                                                             "reason " + C("MERCHANDISE_OR_SERVICE_NOT_RECEIVED") + ", $64.00, evidence <b>Not sent</b>."),
    ("Click <b>Preview evidence pack</b>.", "Capture id, allowance \"Show tickets\" with rule " + C("allowance-rules-v1") + ", all nine rule checks, "
                                            "\"approved by test-buyer &lt;time&gt;\", delivery per unit, refunds, receipt digest, notes and the pack digest."),
    ("Click <b>Submit evidence pack</b>.", "<b>Evidence submitted</b>; the table's evidence column reads <b>Submitted</b>. Clicking it again is refused: one submission per dispute."),
    ("Click the task id in the table.", "The $64.00 receipt with a <b>Dispute WAITING_FOR_SELLER_RESPONSE</b> pill next to its payment status."),
])]
s += [Spacer(1, 8), shots2("27-evidence-preview", "The evidence pack is built from the stored record only.", "29-receipt-dispute-pill", "The disputed receipt carries the pill until PayPal resolves the case.")]

s += [Spacer(1, 6), P("Step 8 · Share a redacted receipt (buyer)", h2)]
s += [steps_table([
    ("Sign in as the <b>buyer</b>, open the <b>$20.30</b> receipt, click <b>Share redacted receipt</b>.", "A <b>Public receipt URL</b> field with a long token."),
    ("Open that URL in a private window.", "\"Shared receipt\" with the status <b>Refund confirmed</b>, the lines, the nine rule checks, the refund and net $7.80. "
                                           "No names, no approval, fulfil or refund buttons, no quote digest."),
    ("Back in the workspace click <b>Revoke share link</b>, reload the private window.", "The link no longer opens."),
])]
s += [Spacer(1, 8), shots2("30-share-link", "The share link, issued by the buyer.", "31-public-receipt", "The public receipt, opened without signing in.")]

# 4. Agent tools
s += [PageBreak(), P("AGENT TOOLS", eyebrow), P("The seven allowance tools", h2)]
s += [P("The stdio MCP entrypoint (" + C("node mcp-server/dist/paypal.js") + ", see <b>docs/guides/paypal-agent.md</b>) gains seven tools when the API has "
        + C("CHAINPAY_PAYPAL_ALLOWANCES=true") + ". It needs an <b>agent</b> grant in " + C("CHAINPAY_PAYPAL_AGENT_TOKEN") + "; a buyer or merchant grant is refused at the MCP boundary. "
        "There is still no tool that approves, captures or refunds money."), Spacer(1, 6)]
s += [two_col([
    (C("paypal_find_allowance") + "<br/>no arguments",
     "The Active allowances this agent may spend from: caps, remaining cents, merchants, mode. The vault block never appears. A paused, revoked or other-agent allowance is simply absent."),
    (C("paypal_search_catalog") + "<br/>" + C("q") + " (text, optional)",
     "Merchants and items with integer " + C("price_cents") + " and availability (" + C("always") + ", " + C("weekdays") + ", " + C("max_per_order:N") + ")."),
    (C("paypal_quote_purchase") + "<br/>" + C("merchant") + ", " + C("items") + " [{id, qty}], " + C("allowance_id") + " (optional)",
     "Lines, " + C("amount_cents") + " and, when an allowance is named, the policy verdict with all checks and a " + C("reason_code") + " when refused. No task, no PayPal call."),
    (C("paypal_purchase") + "<br/>" + C("request_id") + " (16–64 chars), " + C("allowance_id") + ", " + C("merchant") + ", " + C("items"),
     "Buys on an <b>agent_pays</b> allowance. The tool sends " + C('mode: "agent_pays"') + "; the server refuses it on an ask_first allowance. Result " + C("kind") + " is "
     + C("receipt") + " or " + C("refused") + " (with " + C("reason_code") + "). The same request_id returns the same task."),
    (C("paypal_request_approval") + "<br/>same arguments",
     "The same call with " + C('mode: "ask_first"') + ". Creates the task with approval requested and returns " + C("review_url") + "; refused on an agent_pays allowance, so it can never charge. "
     "Result " + C("kind") + " is " + C("approval_requested") + "."),
    (C("paypal_list_approvals") + "<br/>no arguments",
     "This agent's requests still waiting on the buyer. A request the rules fail at approval time comes back " + C("denied") + " with " + C('approved_by: "rules"') + "."),
    (C("paypal_request_refund") + "<br/>" + C("task_id") + " (32 hex), " + C("reason"),
     "Records a refund request for the failed units with a reason. The merchant approves in the workspace."),
], widths=(62 * mm, 108 * mm), header=("Tool and arguments", "What it does")), Spacer(1, 10)]
s += [P("A sample conversation", h3),
      P("Run the entrypoint under an MCP client with the agent grant, then try this. The tool results below are shortened; amounts are exact.", small), Spacer(1, 4)]
s += [chat([
    ("User", "What can you spend on groceries for me?"),
    ("Agent", "Calls " + C("paypal_find_allowance") + "."),
    ("Result", C('{"allowances":[{"id":"al-001","name":"Weekend errands","mode":"agent_pays","merchants":["grocer","box-office"],'
                 '"per_purchase_cap_cents":4000,"total_cap_cents":12000,"spent_cents":0,"remaining_cents":12000,...}]}') + " (no vault block)"),
    ("Agent", "Weekend errands: up to $40.00 per purchase at Corner Grocer and Riverside Box Office, $120.00 left in total. Agent pays."),
    ("User", "Get two oat milks and a bag of coffee beans from the grocer."),
    ("Agent", "Calls " + C("paypal_quote_purchase") + " with " + C('merchant "grocer", items [{"id":"oat-milk","qty":2},{"id":"coffee-beans","qty":1}], allowance_id "al-001"') + "."),
    ("Result", C('{"amount_cents":2030,"policy":{"allowed":true,"reason_code":null,"checks":[{"rule":"status","allowed":true,"observed":"Active"},...]}}')),
    ("Agent", "Calls " + C("paypal_purchase") + " with a fresh " + C("request_id") + " and the same basket."),
    ("Result", C('{"kind":"receipt","review_url":"http://127.0.0.1:5197/paypal/?task=...","receipt":{"captured":true,"gross":"20.30",...}}')),
    ("Agent", "Done: $20.30 captured from your PayPal method. Receipt at the review_url."),
    ("User", "Now two evening show tickets."),
    ("Agent", "Calls " + C("paypal_quote_purchase") + " for box-office under al-001."),
    ("Result", C('{"amount_cents":6400,"policy":{"allowed":false,"reason_code":"per_purchase_cap",...}}')),
    ("Agent", "Refused: $64.00 is over the $40.00 per-purchase cap on Weekend errands. Your Show tickets allowance is ask-first; shall I request approval there?"),
    ("User", "Yes."),
    ("Agent", "Calls " + C("paypal_request_approval") + " with " + C('allowance_id "al-tickets"') + "."),
    ("Result", C('{"kind":"approval_requested","review_url":"...?task=9379f5f3...","receipt":{"captured":false,"purchase":{"approval":"requested",...}}}')),
    ("Agent", "Requested. Nothing is charged until you approve it in the Allowances inbox."),
])]
s += [Spacer(1, 6), P("What should not happen: the agent is never shown a vault token; a " + C("paypal_request_approval") + " on Weekend errands or a " + C("paypal_purchase")
        + " on Show tickets is a 422 from the server; a retried purchase with the same request_id returns the first task, not a second charge.", small)]

# 5. Before merging
s += [PageBreak(), P("REVIEW", eyebrow), P("What to check before merging", h2)]
s += [P("These are the properties the branch claims. Each one can be checked from the workspace or with curl against " + C("http://127.0.0.1:8081/v1/paypal")
        + " using the access codes as bearer tokens."), Spacer(1, 6)]
s += [check_table([
    ("A refused purchase cannot be checked out",
     "Quote $64.00 under Weekend errands (step 4). Then POST " + C("/purchases") + " with that basket anyway.",
     "The UI keeps <b>Buy now</b> disabled. The API answers 200 with a task whose policy is " + C("allowed:false") + ", " + C("reason_code") + " " + C("per_purchase_cap")
     + ", " + C("captured:false") + " and no capture id. It is listed as <b>Refused</b> and the merchant gets 422 on " + C("/fulfil") + "."),
    ("request_id replay",
     "POST " + C("/purchases") + " twice with the same " + C("request_id") + " and the same body; then once more with the same id and a different basket.",
     "The second call returns the same task id, one capture, spent $20.30 not $40.60. The third call is 409."),
    ("The agent never sees the vault",
     "GET " + C("/allowances") + " and " + C("/allowances/:id") + " with the agent code; grep the JSON.",
     "No " + C("vault") + " key, no " + C("approval_url") + ", no token id. The buyer's view has " + C("vault.status") + " and nothing more once it is ready."),
    ("Approve with a stale digest is 409",
     "POST " + C("/purchases/:id/approve") + " as the buyer with a " + C("digest") + " that is not the receipt's " + C("quote_digest") + ".",
     "409 and the request stays <b>Approval requested</b>. With the right digest it captures."),
    ("Merchants get 403s",
     "With the merchant code: POST " + C("/allowances") + ", POST " + C("/purchases") + ", POST " + C("/purchases/:id/approve") + ". Also GET " + C("/allowances") + ".",
     "403 on all three writes. The GET answers " + C('{"allowances":[]}') + ". The agent code gets 403 on " + C("/allowances") + " POST, approve, deny and " + C("/tasks/:id/refund") + "."),
    ("Evidence is submitted once",
     "POST " + C("/disputes/:id/evidence") + " with the preview's digest, then again.",
     "First call: evidence <b>submitted</b>. Second: 409. A wrong digest is also 409 and nothing is sent."),
    ("Mode must match",
     "POST " + C("/purchases") + " with " + C('mode:"ask_first"') + " on Weekend errands, and " + C('mode:"agent_pays"') + " on Show tickets.",
     "422 both times with a message naming the allowance's real mode. Nothing is created."),
    ("Pause is immediate",
     "Pause Weekend errands while the agent has an allowed quote open, then let the agent buy.",
     "The purchase is refused with " + C("allowance_not_active") + "; no capture. Resume and it passes again. Revoke is final: " + C("/status") + " back to Active is 409."),
    ("Re-check at approval",
     "Request an ask-first purchase, pause the allowance, approve the request.",
     "The receipt reads \"Denied by the allowance rules at approval time\", " + C('approved_by:"rules"') + ", and the reserve is released (Spent unchanged)."),
])]
s += [Spacer(1, 10), P("Also run", h3),
      codeblock(["cargo test -p chainpay-backend --features paypal --locked", "cargo fmt --all -- --check",
                 "npm --prefix sdk test && npm --prefix mcp-server test",
                 "npm --prefix frontend run test:browser -- paypal-allowances paypal-disputes"]),
      Spacer(1, 4), P("The browser tests drive the same screens against " + C("frontend/test/fixtures/paypal-allowances.tsx") + ", a mocked API in the page. They do not reach PayPal.", small)]

# 6. Known limits
s += [Spacer(1, 12), P("Known limits", h2)]
s += [two_col([
    ("Sandbox only", "The service refuses any PayPal origin other than " + C("api-m.sandbox.paypal.com") + ". Nothing here is a live payment."),
    ("Vault feature", "Saving a PayPal wallet needs the Vault feature on the sandbox REST app. Without it the PayPal source fails at setup; "
                      "the card source (test card " + C("4111111111111111") + ") is the fallback and the rest of the flow is identical."),
    ("Disputes feature", "Sync and evidence need the Disputes feature on the app. Without it <b>Sync from PayPal</b> shows PayPal's error and the table stays empty."),
    ("Weekdays are UTC", "Items marked \"Weekdays only\" (eggs, bike rental, spiral binding) are checked against the UTC weekday, not the buyer's. "
                         "On a Saturday evening in Bangkok they are still refused until 07:00 Monday local time."),
    ("Max per day is UTC too", "The daily purchase count resets at 00:00 UTC."),
    ("Cooldown in the demo", "The recording sets cooldown 0 so the steps run back to back. With a real value the second purchase under the same allowance is refused with "
                             + C("cooldown") + " until it passes."),
    ("Dispute outcome", "ChainPay submits the pack once and records what PayPal says on the next sync or webhook. It does not decide, appeal or refund on a dispute."),
    ("Seeded catalog", "Merchants and prices are fixed in " + C("backend/src/paypal/catalog.rs") + ". There is no merchant onboarding; this is a test bed for the allowance rules."),
], widths=(40 * mm, 130 * mm))]
s += [Spacer(1, 10), P("If something breaks", h3),
      P("Note the task id (first eight characters are in the sidebar) and the time. Do not create a new task to work around it: every purchase step can be recovered from the original task "
        "by its request_id, and that recovery is part of what is under test. Backend logs print to the terminal running " + C("chainpay-paypal") + ".")]

doc.build(s)
print("ok")
