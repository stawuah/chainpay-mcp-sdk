//! Card connector telemetry (PLAN H). Counters and latencies only: no card
//! ids, tokens, amounts or merchants ever enter this module, so the metrics
//! line and the ops route are safe to ship to any log sink.
//!
//! Counters are per process (a serverless instance restarts at zero); the
//! durable gauges (unresolved reservations, unpaired captures, open repayment
//! mismatches) are recomputed from storage by the ops route.

use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

const LATENCY_WINDOW: usize = 2_048;

/// Counter names. Anything else is refused, so a call site can never smuggle
/// an identifier in as a metric name.
pub const COUNTERS: [&str; 16] = [
    "asa_decisions",
    "asa_approved",
    "asa_timeouts",
    "stale_per_reads",
    "freeze_acks",
    "unpaired_captures",
    "repayment_discrepancies",
    "recovery_freezes",
    "recovery_detections",
    "statements_closed",
    "statements_discharged",
    "periods_rolled",
    "events_applied",
    "reconcile_runs",
    "reservations_closed",
    "intents_closed",
];

#[derive(Debug, Default)]
pub struct CardMetrics {
    counters: Mutex<BTreeMap<&'static str, u64>>,
    latencies: Mutex<VecDeque<u32>>,
}

impl CardMetrics {
    pub fn count(&self, name: &'static str) {
        self.add(name, 1);
    }

    pub fn add(&self, name: &'static str, by: u64) {
        if !COUNTERS.contains(&name) {
            debug_assert!(false, "unknown card metric {name}");
            return;
        }
        *self.counters.lock().unwrap().entry(name).or_insert(0) += by;
    }

    pub fn asa_latency(&self, ms: u128) {
        let mut window = self.latencies.lock().unwrap();
        if window.len() == LATENCY_WINDOW {
            window.pop_front();
        }
        window.push_back(ms.min(u32::MAX as u128) as u32);
    }

    pub fn get(&self, name: &str) -> u64 {
        self.counters
            .lock()
            .unwrap()
            .get(name)
            .copied()
            .unwrap_or(0)
    }

    /// Nearest-rank percentile over the recent ASA window.
    pub fn percentile(&self, p: f64) -> Option<u32> {
        let mut values: Vec<u32> = self.latencies.lock().unwrap().iter().copied().collect();
        if values.is_empty() {
            return None;
        }
        values.sort_unstable();
        let rank = ((p / 100.0) * values.len() as f64).ceil() as usize;
        Some(values[rank.clamp(1, values.len()) - 1])
    }

    pub fn snapshot(&self) -> Value {
        let counters = self.counters.lock().unwrap().clone();
        let samples = self.latencies.lock().unwrap().len();
        let mut all = serde_json::Map::new();
        for name in COUNTERS {
            all.insert(name.into(), json!(counters.get(name).copied().unwrap_or(0)));
        }
        json!({
            "authLatencyMs": {"p50": self.percentile(50.0), "p99": self.percentile(99.0), "samples": samples},
            "counters": all,
        })
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn percentiles_use_nearest_rank_over_a_bounded_window() {
        let m = CardMetrics::default();
        assert_eq!(m.percentile(50.0), None);
        for ms in 1..=100u128 {
            m.asa_latency(ms);
        }
        assert_eq!(m.percentile(50.0), Some(50));
        assert_eq!(m.percentile(99.0), Some(99));
        for _ in 0..LATENCY_WINDOW {
            m.asa_latency(7);
        }
        assert_eq!(m.percentile(99.0), Some(7));
    }

    #[test]
    fn only_named_counters_exist_and_the_snapshot_has_no_identifiers() {
        let m = CardMetrics::default();
        m.count("asa_timeouts");
        m.add("freeze_acks", 2);
        let snap = m.snapshot();
        assert_eq!(snap["counters"]["asa_timeouts"], 1);
        assert_eq!(snap["counters"]["freeze_acks"], 2);
        assert_eq!(snap["counters"].as_object().unwrap().len(), COUNTERS.len());
    }
}
