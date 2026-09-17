import {
  verifyDeliveryAttestation,
  type TrustedSellerMapping,
} from "@chainpay/sdk";
import { BACKEND_URL, PROGRAM_ID } from "../config/client";
import { sellerStateFromHttp, type SellerStatementState } from "./model";

type PublicConfig = {
  cluster?: string;
  program_id?: string;
  programId?: string;
  trusted_sellers?: unknown;
  trustedSellers?: unknown;
};

function mappingFromConfig(value: unknown): TrustedSellerMapping | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const cluster = row.cluster;
  const programId = row.programId ?? row.program_id;
  const sellers = row.sellers;
  if (cluster !== "devnet" || typeof programId !== "string" || !Array.isArray(sellers)) return undefined;
  const identities = sellers.filter((seller): seller is string => typeof seller === "string");
  if (identities.length === 0) return undefined;
  const recipient = row.recipientTokenAccount ?? row.recipient_token_account;
  return {
    cluster: "devnet",
    programId,
    sellers: identities,
    ...(typeof recipient === "string" && recipient ? { recipientTokenAccount: recipient } : {}),
  };
}

export async function loadTrustedSellerMapping(fetchImpl: typeof fetch = fetch): Promise<TrustedSellerMapping | "unavailable"> {
  try {
    const response = await fetchImpl(`${BACKEND_URL.replace(/\/$/, "")}/v1/config`);
    if (!response.ok) return "unavailable";
    const config = await response.json() as PublicConfig;
    const rows = config.trusted_sellers ?? config.trustedSellers;
    if (!Array.isArray(rows)) return "unavailable";
    const programId = config.programId ?? config.program_id ?? PROGRAM_ID;
    const match = rows
      .map(mappingFromConfig)
      .find((mapping) => mapping && mapping.programId === programId && mapping.cluster === "devnet");
    return match ?? {
      cluster: "devnet",
      programId,
      sellers: [],
    };
  } catch {
    return "unavailable";
  }
}

export async function loadSellerStatement(input: {
  receiptAddress: string;
  recipientTokenAccount: string;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
}): Promise<SellerStatementState> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = `${BACKEND_URL.replace(/\/$/, "")}/v1/delivery-attestations/${encodeURIComponent(input.receiptAddress)}`;
  const url = input.refresh ? `${base}?refresh=${Date.now()}` : base;
  let httpStatus: number | null = null;
  let body: unknown;
  try {
    const response = await fetchImpl(url);
    httpStatus = response.status;
    if (response.status === 404) return { status: "absent" };
    if (response.status !== 200) {
      return sellerStateFromHttp({ httpStatus: response.status });
    }
    body = await response.json();
  } catch {
    return sellerStateFromHttp({ httpStatus: null, networkError: true });
  }

  if (!globalThis.crypto?.subtle) {
    return sellerStateFromHttp({ httpStatus, body, cryptoUnavailable: true });
  }

  const trusted = await loadTrustedSellerMapping(fetchImpl);
  if (trusted === "unavailable") {
    return { status: "unavailable", reason: "Trusted seller list could not be loaded." };
  }

  const verification = await verifyDeliveryAttestation(body, {
    programId: PROGRAM_ID,
    trustedSellers: trusted,
    receipt: {
      address: input.receiptAddress,
      recipientTokenAccount: input.recipientTokenAccount,
    },
  });

  return sellerStateFromHttp({
    httpStatus,
    body,
    verification: { valid: verification.valid, reason: verification.reason },
  });
}
