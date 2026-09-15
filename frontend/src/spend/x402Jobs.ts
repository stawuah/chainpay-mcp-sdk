import { authorizedFetch } from "../session";
import { BACKEND_URL } from "../config/client";
import { x402CycleSteps, x402StatusLabel, type X402ProtocolSummary } from "./x402Display";

export type X402Job = {
  x402_payment_id: string;
  resource: string;
  mandate?: string;
  amount?: string;
  status: string;
  protocol: string;
  payable: boolean;
  receipt_address?: string;
  transaction_signature?: string;
  error?: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export { summarizeX402Challenge, x402CycleSteps, x402StatusLabel, type X402ProtocolSummary } from "./x402Display";

export async function fetchX402Jobs(mandate?: string): Promise<X402Job[]> {
  const params = new URLSearchParams();
  if (mandate) params.set("mandate", mandate);
  const query = params.toString();
  const url = `${BACKEND_URL.replace(/\/$/, "")}/v1/x402-payments${query ? `?${query}` : ""}`;
  const response = await authorizedFetch(url);
  if (!response.ok) throw new Error("Could not load HTTP 402 jobs for this wallet.");
  const payload = await response.json() as { jobs?: X402Job[] };
  return payload.jobs ?? [];
}
