import type { DashboardTab } from "../routing/paths";
import { FIRST_MANDATE_TITLE } from "../owner/onboarding";

/*
  Page header copy, one entry per tab.

  This previously lived as a nested ternary chain inside a single 2,468-character
  line of Dashboard.tsx. Only four kicker values existed, so Receipts, Developer
  tools, Settings and Protocol all rendered "CONTROL CENTER".
*/
export type TabCopy = {
  kicker: string;
  title: string;
  subtitle: string;
};

type CopyContext = {
  /** First-run owners get a setup title on Overview instead of a greeting. */
  hasMandates: boolean;
  /** The mandate builder replaces the Spending permissions subtitle. */
  mandateCreateOpen: boolean;
};

const STATIC: Record<Exclude<DashboardTab, "overview" | "mandates">, TabCopy> = {
  agents: {
    kicker: "AGENT ACCESS",
    title: "Agents.",
    subtitle:
      "Pair an external MCP client or use the dashboard assistant. Your mandate sets the spend limit; pairing controls who may call payment tools.",
  },
  "connect-mcp": {
    kicker: "AGENT ACCESS",
    title: "Agents.",
    subtitle:
      "Pair an external MCP client or use the dashboard assistant. Your mandate sets the spend limit; pairing controls who may call payment tools.",
  },
  payments: {
    kicker: "SETTLEMENT",
    title: "Route a payment.",
    subtitle: "Check the request, then approve the payment in your wallet.",
  },
  receipts: {
    kicker: "PROOF OF PAYMENT",
    title: "Receipts.",
    subtitle: "Preview, verify, and send durable proof for every confirmed settlement.",
  },
  assistant: {
    kicker: "PAYMENT REQUESTS",
    title: "Requests.",
    subtitle:
      "Bring an invoice or payment request here. ChainPay verifies it against your mandate and shows what the agent is buying before wallet approval.",
  },
  tools: {
    kicker: "AGENT INTERFACE",
    title: "Developer tools.",
    subtitle: "The exact tools agents can call. Nothing else is exposed.",
  },
  protocol: {
    kicker: "PROGRAM ADMIN",
    title: "Protocol setup.",
    subtitle: "Initialize the protocol asset list from the authority wallet.",
  },
  settings: {
    kicker: "ACCOUNT",
    title: "Settings.",
    subtitle: "Solana Devnet status, wallet controls, and account actions.",
  },
};

export function tabCopy(tab: DashboardTab, context: CopyContext): TabCopy {
  if (tab === "overview") {
    return context.hasMandates
      ? {
          kicker: "SPEND OVERVIEW",
          title: "Overview.",
          subtitle:
            "Spend so far against the limit you approved, and anything waiting on you.",
        }
      : {
          kicker: "CONTROL CENTER",
          title: `${FIRST_MANDATE_TITLE}.`,
          subtitle: "Connect your wallet, set your limits, then give your agent access.",
        };
  }

  if (tab === "mandates") {
    return {
      kicker: "POLICY CONTROL",
      title: "Spending permissions.",
      subtitle: context.mandateCreateOpen
        ? "Create a policy for an agent to follow before a payment can be signed."
        : "A mandate is an on-chain spending permission. Review the rules your agent must follow before paying.",
    };
  }

  return STATIC[tab];
}
