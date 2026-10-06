import {
  DEVNET_TEE_URL,
  MAGICBLOCK_DEVNET_TEE_MEASUREMENTS,
  createTdxQuoteProvider,
  parseMeasurementAllowlist,
  teeMeasurementAllowlist,
  verifyTee,
  type TeeMeasurement,
} from "@chainpayhq/sdk";
import type { PrivacyCheckResult } from "./source";

/*
 * Browser TEE attestation for the privacy check (contracts CD-6).
 *
 * One fresh quote from the Devnet TEE: Intel's DCAP signature chain is
 * verified in the browser with @phala/dcap-qvl (the verifier MagicBlock's
 * own SDK uses, loaded on demand), and the same quote's MRTD/RTMR0-3/MROWNER
 * must equal MagicBlock's confirmed Devnet build. Enforce mode: anything
 * short of both is shown as a failure, never softened.
 */

const PCCS_URL = "https://pccs.phala.network/tdx/certification/v4";
/** dcap-qvl verdicts that still mean a genuine, patched platform. Anything else (OutOfDate, Revoked…) fails. */
const ACCEPTED_TCB = new Set(["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"]);

type DcapModule = {
  getCollateral(pccsUrl: string, quote: Uint8Array): Promise<unknown>;
  verify(quote: Uint8Array, collateral: unknown, nowSeconds: number): { status: string };
};

async function loadDcap(): Promise<DcapModule | null> {
  try {
    const mod = (await import("@phala/dcap-qvl")) as unknown as DcapModule & { default?: DcapModule };
    const dcap = typeof mod.verify === "function" ? mod : mod.default;
    return dcap && typeof dcap.verify === "function" && typeof dcap.getCollateral === "function" ? dcap : null;
  } catch {
    return null;
  }
}

/** Rotation hook: a deployment can allow MagicBlock's previous build during an upgrade without a release. */
function previousEntries(): TeeMeasurement[] {
  try {
    return parseMeasurementAllowlist(import.meta.env.VITE_CHAINPAY_TEE_MEASUREMENTS_PREVIOUS).map((entry) => ({ ...entry, label: entry.label ?? "previous" }));
  } catch {
    return [];
  }
}

export async function checkTeeAttestation(): Promise<PrivacyCheckResult["attestation"]> {
  const dcap = await loadDcap();
  const verifyQuote = dcap
    ? async (raw: Uint8Array) => {
        const collateral = await dcap.getCollateral(PCCS_URL, raw);
        const { status } = dcap.verify(raw, collateral, Math.floor(Date.now() / 1000));
        if (!ACCEPTED_TCB.has(status)) throw new Error(`TCB status ${status}`);
      }
    : undefined;
  const result = await verifyTee({
    mode: "enforce",
    teeUrl: DEVNET_TEE_URL,
    allowlist: teeMeasurementAllowlist(previousEntries()),
    provider: createTdxQuoteProvider(verifyQuote ? { verifyQuote } : {}),
  });
  return {
    hardware: result.hardware,
    measurements: result.measurements,
    label: result.label,
    provenance: MAGICBLOCK_DEVNET_TEE_MEASUREMENTS.provenance,
  };
}
