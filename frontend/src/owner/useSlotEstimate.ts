import { useEffect, useState } from "react";
import { chainpayClient } from "../config/client";
import { fetchOnePerformanceSample, slotDurationFromSample, type SlotDurationEstimate } from "./slotEstimate";
import { retryRead } from "./retryRead";

export function useSlotEstimate() {
  const [estimate, setEstimate] = useState<SlotDurationEstimate | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let active = true;
    void retryRead(() => fetchOnePerformanceSample(chainpayClient.connection), {
      cancelled: () => !active,
    }).then((sample) => {
      if (!active) return;
      const next = sample ? slotDurationFromSample(sample) : null;
      setEstimate(next);
      setStatus(next ? "ready" : "unavailable");
    });
    return () => {
      active = false;
    };
  }, []);

  return { estimate, status };
}
