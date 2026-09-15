export const FIRST_MANDATE_TITLE = "Set up your first mandate";

export const OWNER_SETUP_STEPS = [
  {
    key: "connect",
    label: "Connect wallet",
    detail: "Choose the owner wallet that holds the funds.",
  },
  {
    key: "signin",
    label: "Sign in",
    detail: "A login message proves this browser session. It does not approve a payment or create a mandate.",
  },
  {
    key: "review",
    label: "Review mandate",
    detail: "Check the exact amount, mint, agent, and expiry slot before anything is signed.",
  },
  {
    key: "approve",
    label: "Approve in wallet",
    detail: "The wallet transaction creates the on-chain mandate. That is the financial approval.",
  },
] as const;

export const LOGIN_VS_APPROVAL = "Sign in is a login message. Mandate approval is a separate wallet transaction.";

export const EMPTY_OWNER_ACTIVITY = "No payments for this wallet yet.";

export const DEMO_RECEIPT_LINK_LABEL = "View demo receipt";

export function configuredDemoReceiptPath(pda: string | undefined) {
  const value = pda?.trim();
  if (!value) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  return `/verify/${encodeURIComponent(value)}`;
}
