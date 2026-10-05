// Every word on /use-cases lives here. Rules: _bmad-output/design-council/use-cases-ruling-2026-10-03.md (U6, U7).
// Plain words in titles and steps. Example numbers are illustrative and labeled "Example" on the page.

export type Audience = "builders" | "business" | "sellers";
export type UseCaseStatus = "live" | "soon";

export type UseCase = {
  slug: string;
  audience: Audience;
  status: UseCaseStatus;
  title: string;
  summary: string;
  steps: readonly [string, string, string];
  why: readonly string[];
  example: readonly (readonly [string, string])[];
  cta: { label: string; href: string };
  imageAlt: string;
  featured?: boolean;
  /** CTA band copy for a "soon" case that is not built yet. Defaults to the built-and-switched-off wording. */
  soonNote?: { title: string; body: string };
};

export const AUDIENCES: readonly { id: Audience; label: string }[] = [
  { id: "builders", label: "Agent builders" },
  { id: "business", label: "Businesses" },
  { id: "sellers", label: "Sellers" },
];

export const STATUS_LABEL: Record<UseCaseStatus, string> = {
  live: "Live on devnet",
  soon: "Coming soon",
};

const DASHBOARD = { label: "Open dashboard", href: "/app" };
// A real Devnet receipt, so the button opens a card instead of an empty lookup.
// Same address as DEMO_RECEIPT_PATH in receipts/demoReceipt.ts (a test pins it);
// written out because this file stays import-free.
export const RECEIPT = { label: "See a receipt", href: "/verify/7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q" };
const SPENDING_PERMISSION = { label: "Set a spending limit", href: "/app/mandates" };
const MCP_DOCS = { label: "Read the MCP docs", href: "https://chainpay-mcp.vercel.app/docs" };
const SELLER_GUIDE = {
  label: "Read the seller guide",
  href: "https://github.com/stawuah/chainpay-mcp-sdk/blob/master/docs/guides/trusted-sellers.md",
};

export const USE_CASES: readonly UseCase[] = [
  {
    slug: "sponsor-funds-your-agent",
    audience: "builders",
    status: "live",
    featured: true,
    title: "A sponsor funds your agent",
    summary: "A hackathon or sponsor gives your agent a budget. The money never leaves their wallet.",
    steps: [
      "You send your sponsor a budget request link.",
      "They check it and approve a limit from their own wallet.",
      "Your agent spends inside that limit. They see every receipt.",
    ],
    why: [
      "No upfront transfer, so nobody has to trust you with a lump sum.",
      "The limit is enforced on Solana, not by a promise.",
      "Sponsors can pause or end the budget any time.",
    ],
    example: [["Request", "Builder budget"], ["Limit", "500 USDC total"], ["Ends", "When the hackathon does"], ["Funds held by", "The sponsor's wallet"]],
    cta: DASHBOARD,
    imageAlt: "An open gift box releasing a 500 USDC chip toward the ChainPay robot.",
  },
  {
    slug: "pay-per-api-call",
    audience: "builders",
    status: "live",
    title: "Pay per API call",
    summary: "Your agent pays a few cents each time it calls a paid API. No monthly plan, no shared card.",
    steps: [
      "The API asks for a small payment before it answers.",
      "Your agent pays it, inside the limit you set.",
      "The API checks the receipt and sends the answer.",
    ],
    why: [
      "You pay for what the agent actually used.",
      "A runaway loop hits your limit, not your bank account.",
      "Every call has a receipt you can look up.",
    ],
    example: [["Price", "0.01 USDC per call"], ["Per payment cap", "0.05 USDC"], ["Proof", "x402-style receipt check (custom)"]],
    cta: MCP_DOCS,
    imageAlt: "Three API tiles, each with a 0.01 USDC chip clicking into place.",
  },
  {
    slug: "research-agent-buys-data",
    audience: "builders",
    status: "live",
    title: "Your research agent buys the data",
    summary: "Your agent hits a paywalled report, pays for it, and keeps working. You never get the 2am ping.",
    steps: [
      "Your agent finds a report it needs behind a paywall.",
      "It checks the price against your limit and pays.",
      "It reads the report. You get the receipt.",
    ],
    why: [
      "Research doesn't stall waiting for you to pay.",
      "Prices above your cap get refused automatically.",
      "You see exactly what was bought and for how much.",
    ],
    example: [["Bought", "Market report"], ["Paid", "2 USDC"], ["Cap per payment", "5 USDC"]],
    cta: DASHBOARD,
    imageAlt: "A stack of report folders with a 2 USDC chip on top, the ChainPay robot beside them.",
  },
  {
    slug: "buy-tools-from-a-catalog",
    audience: "builders",
    status: "live",
    title: "Buy tools from a catalog",
    summary: "Your agent picks a priced tool from a catalog and gets a quote before it spends anything.",
    steps: [
      "Your agent browses tools with clear prices.",
      "It gets a quote and checks it fits your limit.",
      "It buys only what fits.",
    ],
    why: [
      "Prices are known before money moves.",
      "Tools outside your limit are never bought.",
      "One permission covers many small purchases.",
    ],
    example: [["Catalog", "Pay.sh"], ["Quote", "5 USDC"], ["Allowance left", "45 USDC"]],
    cta: MCP_DOCS,
    imageAlt: "A shelf of tool boxes, one pulled forward with a 5 USDC price tag.",
  },
  {
    slug: "pay-from-your-ai-app",
    audience: "builders",
    status: "live",
    title: "Pay from the AI app you already use",
    summary: "Connect ChainPay to Claude, Cursor, or any MCP app. Your agent can pay without leaving the chat.",
    steps: [
      "Add the ChainPay connection to your AI app.",
      "Ask your agent to buy something.",
      "It prepares the payment. Your rules decide if it goes through.",
    ],
    why: [
      "No new app to learn.",
      "The connection holds no keys.",
      "Your limits apply in every app you connect.",
    ],
    example: [["Connection", "MCP"], ["Tools", "Mandates, payments, receipts"], ["Keys held by ChainPay", "None"]],
    cta: MCP_DOCS,
    imageAlt: "A chat window with an approval card and the ChainPay logo.",
  },
  {
    slug: "team-agent-allowance",
    audience: "business",
    status: "live",
    title: "Give a team agent an allowance",
    summary: "Set a budget, a per-payment cap, and an end date. The agent can't go past any of them.",
    steps: [
      "Pick the agent and the token it can spend.",
      "Set the total, the max per payment, and when it ends.",
      "Approve once from your wallet. Done.",
    ],
    why: [
      "Your funds stay in your wallet the whole time.",
      "Solana refuses anything over the limit.",
      "It ends on its own. No forgotten subscriptions.",
    ],
    example: [["Total", "25 USDC"], ["Max per payment", "5 USDC"], ["Ends", "Friday"]],
    cta: DASHBOARD,
    imageAlt: "A week strip partly filled in blue with a 25 USDC chip, the robot peeking from behind.",
  },
  {
    slug: "receipts-for-accounting",
    audience: "business",
    status: "live",
    title: "Receipts your accountant can read",
    summary: "Every payment leaves a receipt with who paid, what for, and under which limit. Share it or export it.",
    steps: [
      "Your agent pays. A receipt is saved on Solana.",
      "Open it as a clean card, or share a public link.",
      "Export everything as a CSV for your books.",
    ],
    why: [
      "Anyone can check a receipt without a wallet.",
      "Each receipt says if its limits were saved at payment.",
      "CSV drops straight into a spreadsheet.",
    ],
    example: [["Receipt", "Public verify link"], ["Shows", "Amount, payee, limits when recorded"], ["Export", "CSV"]],
    cta: RECEIPT,
    imageAlt: "A paper receipt stamped with the ChainPay logo next to an open ledger.",
  },
  {
    slug: "invoices-matched-to-payments",
    audience: "business",
    status: "live",
    title: "Invoices matched to payments",
    summary: "ChainPay lines up the order, the invoice, and the payment. If they don't match, it says so.",
    steps: [
      "A vendor's order comes in with an amount and a token.",
      "Your agent pays against it.",
      "ChainPay compares them and flags any difference.",
    ],
    why: [
      "Wrong amounts get caught, not buried.",
      "Duplicate invoices are blocked.",
      "Month-end review takes minutes.",
    ],
    example: [["Order", "120 USDC"], ["Paid", "120 USDC"], ["Result", "Matched"]],
    cta: DASHBOARD,
    imageAlt: "An invoice and a receipt joined by a blue link with a check badge.",
  },
  {
    slug: "approve-big-buys-yourself",
    audience: "business",
    status: "live",
    title: "Approve big buys yourself",
    summary: "Let small stuff run on its own. For anything big, the agent asks and you sign.",
    steps: [
      "Choose \"Ask me first\" for a permission.",
      "Your agent prepares the payment and waits.",
      "You approve it in your wallet, or don't.",
    ],
    why: [
      "Nothing big moves without your signature.",
      "The agent still does the busywork.",
      "You can switch modes later.",
    ],
    example: [["Mode", "Ask me first"], ["Waiting for", "Your wallet signature"]],
    cta: DASHBOARD,
    imageAlt: "A large blue approve button next to a small toggle.",
  },
  {
    slug: "one-tap-stop",
    audience: "business",
    status: "live",
    title: "Stop every agent in one tap",
    summary: "Something looks off? Pause one agent or revoke them all. It takes effect on Solana right away.",
    steps: [
      "Open your permissions.",
      "Pause one, or revoke all.",
      "Approve in your wallet. Spending stops.",
    ],
    why: [
      "No support ticket, no waiting.",
      "Pausing is reversible. Revoking is final.",
      "Past receipts stay intact.",
    ],
    example: [["Action", "Revoke all"], ["Takes effect", "Next Solana block"]],
    cta: DASHBOARD,
    imageAlt: "A toggle switch with a pause symbol, switched off, with chips frozen beside it.",
  },
  {
    slug: "private-agent-card",
    audience: "business",
    status: "soon",
    title: "Give your agent a card",
    summary: "A virtual card for your agent. You set the limits, it buys inside them. In testing with a sandbox card issuer.",
    steps: [
      "Set a monthly budget and a per-purchase cap.",
      "Pick the shops it can buy from.",
      "Over the cap or off the list? Declined.",
    ],
    why: [
      "Limits stay off the public chain. Seen by you, readers you add, ChainPay's approver and the card issuer.",
      "Freeze it in one tap.",
      "Every purchase leaves a card record, not a Solana payment receipt.",
    ],
    example: [["Bought", "Data API credits"], ["Paid", "$20"], ["Cap per purchase", "$30"]],
    cta: DASHBOARD,
    soonNote: {
      title: "Coming soon. In testing now.",
      body: "Cards get their own limits. For API payments today, give your agent a spending permission.",
    },
    imageAlt: "A white payment card with the ChainPay logo, half hidden behind frosted blue glass with a small lock, the ChainPay robot peeking over the top.",
  },
  {
    slug: "spend-overview-anywhere",
    audience: "business",
    status: "live",
    title: "See spend inside your own tools",
    summary: "Drop a live spend overview into your team's dashboard or wiki. No login needed to view it.",
    steps: [
      "Copy the embed link for your wallet.",
      "Paste it into your internal page.",
      "Your team sees spend against limits, always current.",
    ],
    why: [
      "Finance sees spend without dashboard access.",
      "Read-only, so nobody can change anything.",
      "Always reads the latest numbers from Solana.",
    ],
    example: [["Embed", "/embed/overview/<your wallet>"], ["Access", "View only"]],
    cta: DASHBOARD,
    imageAlt: "A dashboard panel with a blue bar chart and a limit line.",
  },
  {
    slug: "get-paid-by-agents",
    audience: "sellers",
    status: "live",
    title: "Get paid by agents",
    summary: "Put a price on your API or content. Agents pay, you check the receipt, you serve the request.",
    steps: [
      "Return a payment request when an agent calls you.",
      "The agent pays inside its owner's limit.",
      "Check the receipt and send the response.",
    ],
    why: [
      "No accounts or API keys to hand out.",
      "Every payment is checked by the same rules.",
      "You get paid before you serve.",
    ],
    example: [["Response", "402 Payment Required"], ["Proof", "Signature + receipt (custom x402/1.0)"]],
    cta: MCP_DOCS,
    imageAlt: "A shop door with a 402 sign and blue light, the robot waiting in front.",
  },
  {
    slug: "send-a-purchase-order-link",
    audience: "sellers",
    status: "live",
    title: "Send a purchase-order link",
    summary: "Send one link. The buyer reviews it and approves a matching limit for their agent.",
    steps: [
      "Create a purchase-order link with your price.",
      "The buyer opens it and sees the permission filled in.",
      "They approve. Their agent can now pay you.",
    ],
    why: [
      "No back-and-forth on amounts.",
      "The buyer stays in control.",
      "Payments match your order automatically.",
    ],
    example: [["Link", "Signed purchase order"], ["Prefills", "Amount, token, end date"]],
    cta: DASHBOARD,
    imageAlt: "An open envelope with a PO link card sliding out.",
  },
  {
    slug: "prove-you-delivered",
    audience: "sellers",
    status: "live",
    title: "Prove you delivered",
    summary: "Sign a delivery note against the receipt. The buyer sees both side by side.",
    steps: [
      "Get paid. A receipt exists.",
      "Sign a short delivery note for that receipt.",
      "The buyer sees paid and delivered together.",
    ],
    why: [
      "Fewer \"did it arrive?\" messages.",
      "The note is tied to one specific payment.",
      "Only trusted sellers can sign.",
    ],
    example: [["Receipt", "Settled"], ["Delivery note", "Signed by seller"]],
    cta: SELLER_GUIDE,
    imageAlt: "A parcel with a blue check seal next to a small certificate.",
  },
  {
    slug: "agent-shopping",
    audience: "sellers",
    status: "soon",
    title: "Agents that shop online",
    summary: "Your agent checks out online through a partner, inside your limit, with a receipt at the end.",
    steps: [
      "Your agent finds the product.",
      "It places the order through a checkout partner.",
      "The order ends at a ChainPay receipt.",
    ],
    why: [
      "Real-world goods, same limits.",
      "Order and payment live in one place.",
      "Off by default until it's ready.",
    ],
    example: [["Checkout partner", "Crossmint"], ["Status", "Coming soon"]],
    cta: SPENDING_PERMISSION,
    soonNote: {
      title: "Coming soon. Switched off for now.",
      body: "Checkout stays off until Crossmint signs off, so no order can start yet. Meanwhile, set up the spending limit your agent would shop with.",
    },
    imageAlt: "A shopping bag with the ChainPay logo, the robot behind it.",
  },
  {
    // Planning only: _bmad-output/planning-artifacts/chainpay-paypal-2026-10-03. Copy per landing-brand ruling B5.
    slug: "paypal-invoices",
    audience: "sellers",
    status: "soon",
    title: "PayPal invoices, paid on Solana",
    summary: "Your buyer pays a PayPal sandbox invoice on Solana. Once you approve, PayPal records it as paid. No money goes through PayPal.",
    steps: [
      "You send a PayPal sandbox invoice. The buyer gets a ChainPay link to pay.",
      "The buyer approves the exact amount on Solana. A receipt is saved.",
      "You check the receipt, then approve marking the invoice paid in PayPal.",
    ],
    why: [
      "The money moves on Solana. PayPal only keeps a record.",
      "Two separate records: the Solana receipt and the PayPal entry.",
      "If PayPal is slow to answer, nobody gets asked to pay twice.",
    ],
    example: [
      ["Invoice", "USD 12.50 · PayPal sandbox"],
      ["Paid on Solana", "12.500000 test tokens · Devnet"],
      ["PayPal record", "External payment · you approve it"],
      ["Moved through PayPal", "Nothing"],
    ],
    cta: RECEIPT,
    soonNote: {
      title: "Coming soon. Not built yet.",
      body: "It's planned and needs PayPal sandbox checks first. Every Solana payment already gets a receipt you can share or export.",
    },
    imageAlt: "A white invoice with a navy header and a blue check tab clipped to its top edge, and in front of it a receipt slip stamped with the ChainPay logo.",
  },
];

export function findUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((item) => item.slug === slug);
}

export function imageFor(item: UseCase, size: "card" | "hero"): string {
  return `/use-cases/${item.slug}-${size === "card" ? 800 : 1600}.webp`;
}
