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
    title: "Agents",
    subtitle:
      "Manage your agents, their access, and their activity.",
  },
  "connect-mcp": {
    kicker: "AGENT ACCESS",
    title: "Agents",
    subtitle:
      "Manage your agents, their access, and their activity.",
  },
  payments: {
    kicker: "SETTLEMENT",
    title: "Payments",
    subtitle: "Track payments and open their receipts.",
  },
  receipts: {
    kicker: "PROOF OF PAYMENT",
    title: "Payment receipt",
    subtitle: "Preview, verify, and send durable proof for every confirmed settlement.",
  },
  assistant: {
    kicker: "PAYMENT REQUESTS",
    title: "Requests",
    subtitle:
      "Review what needs you and follow your requests.",
  },
  tools: {
    kicker: "AGENT INTERFACE",
    title: "Developer tools",
    subtitle: "Technical reference for agent integrations. Access depends on the connection’s scope.",
  },
  protocol: {
    kicker: "PROGRAM ADMIN",
    title: "Protocol administration",
    subtitle: "Initialize the protocol asset list from the authority wallet.",
  },
  settings: {
    kicker: "ACCOUNT",
    title: "Settings",
    subtitle: "Manage your wallet, account access, and advanced tools.",
  },
};

export function tabCopy(tab: DashboardTab, context: CopyContext): TabCopy {
  if (tab === "overview") {
    return { kicker: "", title: "Overview", subtitle: "Your agents, spending, and what needs you." };
  }

  if (tab === "mandates") {
    return {
      kicker: "POLICY CONTROL",
      title: context.mandateCreateOpen ? "New spending permission" : "Spending permissions",
      subtitle: context.mandateCreateOpen
        ? "A few clear limits. You stay in control."
        : "Decide how much your agents can spend.",
    };
  }

  return STATIC[tab];
}
