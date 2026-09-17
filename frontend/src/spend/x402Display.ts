export type X402ProtocolSummary = {
  protocol: string;
  label: string;
  payable: boolean;
  amount?: string;
  blockedReason?: string;
};

export type X402JobLike = {
  payable: boolean;
  status: string;
  payment_id?: string;
  error?: string;
};

export function x402JobResumable(job: X402JobLike): boolean {
  return Boolean(job.payment_id) && job.payable && (job.status === "submitted" || job.status === "confirmed" || job.status === "prepared");
}

const PROTOCOL_LABELS: Record<string, string> = {
  chainpay_custom_x402: "ChainPay custom x402/1.0",
  standard_x402_v2: "Standard x402 v2",
  mpp: "MPP (pay.sh sibling 402)",
  unknown: "Unknown 402 challenge",
};

const STATUS_LABELS: Record<string, string> = {
  prepared: "Prepared",
  submitted: "Submitted",
  confirmed: "Confirmed",
  verified: "Verified",
  failed: "Failed",
};

/** Read protocol + amount from a stored challenge JSON. Amount stays a decimal string. */
export function summarizeX402Challenge(challenge: unknown): X402ProtocolSummary {
  const value = challenge && typeof challenge === "object" && !Array.isArray(challenge)
    ? challenge as Record<string, unknown>
    : {};

  if (value.x402Version === 2) {
    const amount = firstAcceptField(value, "maxAmountRequired");
    return {
      protocol: "standard_x402_v2",
      label: PROTOCOL_LABELS.standard_x402_v2,
      payable: false,
      amount,
      blockedReason: "x402_unsupported_sponsor",
    };
  }

  if (value.version === "x402/1.0") {
    const amount = typeof value.amount === "string"
      ? value.amount
      : firstAcceptField(value, "amount");
    return {
      protocol: "chainpay_custom_x402",
      label: PROTOCOL_LABELS.chainpay_custom_x402,
      payable: true,
      amount,
    };
  }

  if (value.version === "mpp" || value.mppVersion !== undefined) {
    return {
      protocol: "mpp",
      label: PROTOCOL_LABELS.mpp,
      payable: false,
      blockedReason: "x402_unsupported_sponsor",
    };
  }

  return {
    protocol: "unknown",
    label: PROTOCOL_LABELS.unknown,
    payable: false,
    blockedReason: "x402_unsupported_sponsor",
  };
}

function firstAcceptField(challenge: Record<string, unknown>, field: string): string | undefined {
  const accepts = challenge.accepts;
  if (!Array.isArray(accepts) || !accepts.length) return undefined;
  const first = accepts[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  const candidate = (first as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

export function x402StatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function x402CycleSteps(job: X402JobLike): string[] {
  const steps = ["Challenge seen", "Protocol check", "Mandate policy", "Sign + settle", "Receipt proof"];
  if (!job.payable) return [steps[0], steps[1], "Seen, not payable on ChainPay"];
  switch (job.status) {
    case "prepared":
      return [steps[0], steps[1], steps[2], "Waiting to sign"];
    case "submitted":
      return [steps[0], steps[1], steps[2], steps[3], "Confirming on chain"];
    case "confirmed":
      return [steps[0], steps[1], steps[2], steps[3], "Awaiting resource proof"];
    case "verified":
      return [steps[0], steps[1], steps[2], steps[3], steps[4], "Done"];
    case "failed":
      return [steps[0], steps[1], steps[2], job.error ? `Failed · ${job.error}` : "Failed"];
    default:
      return steps;
  }
}
