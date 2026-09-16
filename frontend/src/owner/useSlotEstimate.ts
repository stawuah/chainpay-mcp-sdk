import { useEffect, useState } from "react";
import { chainpayClient } from "../config/client";
import { fetchOnePerformanceSample, slotDurationFromSample, type SlotDurationEstimate } from "./slotEstimate";

export function useSlotEstimate() {
  const [estimate, setEstimate] = useState<SlotDurationEstimate | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let active = true;
    void fetchOnePerformanceSample(chainpayClient.connection).then((sample) => {
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
