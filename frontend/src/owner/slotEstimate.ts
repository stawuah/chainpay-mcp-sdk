export type PerformanceSample = {
  numSlots: number;
  samplePeriodSecs: number;
};

export type SlotDurationEstimate = {
  secondsPerSlot: number;
  slotsPerDay: number;
  estimated: true;
};

export function slotDurationFromSample(sample: PerformanceSample): SlotDurationEstimate | null {
  if (!Number.isFinite(sample.numSlots) || sample.numSlots <= 0) return null;
  if (!Number.isFinite(sample.samplePeriodSecs) || sample.samplePeriodSecs <= 0) return null;
  const secondsPerSlot = sample.samplePeriodSecs / sample.numSlots;
  if (!Number.isFinite(secondsPerSlot) || secondsPerSlot <= 0) return null;
  const slotsPerDay = 86_400 / secondsPerSlot;
  if (!Number.isFinite(slotsPerDay) || slotsPerDay <= 0) return null;
  return { secondsPerSlot, slotsPerDay, estimated: true };
}

export function estimatedSlotsForDays(days: number, estimate: SlotDurationEstimate): bigint | null {
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  const slots = Math.round(days * estimate.slotsPerDay);
  if (!Number.isFinite(slots) || slots <= 0) return null;
  return BigInt(slots);
}

export function parseExpirySlot(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Enter the exact expiry slot as a whole number.");
  }
  return BigInt(normalized);
}

export function estimatedExpiryDate(expiresAtSlot: bigint, currentSlot: bigint, secondsPerSlot: number) {
  if (expiresAtSlot <= currentSlot) return null;
  const secondsUntilExpiry = Number(expiresAtSlot - currentSlot) * secondsPerSlot;
  if (!Number.isFinite(secondsUntilExpiry) || secondsUntilExpiry <= 0) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(Date.now() + secondsUntilExpiry * 1000));
}

export function mandateExpiryLabel(
  expiresAtSlot: bigint,
  currentSlot: bigint | null,
  estimate: SlotDurationEstimate | null,
) {
  const slot = expiresAtSlot.toString();
  if (currentSlot !== null && expiresAtSlot <= currentSlot) return "Expired";
  if (currentSlot === null || !estimate) return `Expiry slot ${slot}`;
  const date = estimatedExpiryDate(expiresAtSlot, currentSlot, estimate.secondsPerSlot);
  return date ? `Estimated ${date} · slot ${slot}` : `Estimated slot ${slot}`;
}

export function sampleFromRpcResult(samples: unknown): PerformanceSample | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const first = samples[0] as { numSlots?: unknown; samplePeriodSecs?: unknown };
  const numSlots = Number(first?.numSlots);
  const samplePeriodSecs = Number(first?.samplePeriodSecs);
  if (!Number.isFinite(numSlots) || !Number.isFinite(samplePeriodSecs)) return null;
  return { numSlots, samplePeriodSecs };
}

export type RecentPerformanceRpc = {
  getRecentPerformanceSamples: (limit: number) => Promise<unknown>;
};

export async function fetchOnePerformanceSample(rpc: RecentPerformanceRpc): Promise<PerformanceSample | null> {
  try {
    return sampleFromRpcResult(await rpc.getRecentPerformanceSamples(1));
  } catch {
    return null;
  }
}
