// ILLUSTRATIVE owner-webhook fixtures for the design harness and tests. The
// in-memory source behaves like the relay routes; nothing leaves the page.
import type { WebhookDelivery, WebhookEndpoint, WebhooksSource } from "../../src/dashboard/webhooks/source";
import { WebhooksOffError } from "../../src/dashboard/webhooks/source";

export type WebhooksFixture = "fixture" | "empty" | "off" | "fail";

const NOW = Date.UTC(2026, 9, 5, 9, 30);
const MIN = 60_000;
const RECEIPTS = ["7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q", "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", "3Rcpt2v2SnapshotFixture111111111111111111", "4RcptMatchedPurchaseFixture11111111111111"];

function endpoint(id: string, url: string, description: string | null, status: WebhookEndpoint["status"], created: number): WebhookEndpoint {
  return { id, url, description, status, created_at_ms: created, updated_at_ms: created, previous_secret_expires_at_ms: null };
}

function delivery(n: number, state: WebhookDelivery["state"], extra: Partial<WebhookDelivery> = {}): WebhookDelivery {
  const created = NOW - (n + 1) * 37 * MIN;
  return { id: `dlv_fixture_${n}`, event_id: `evt_${(n + 1).toString(16).padStart(32, "a")}`, event_type: "payment.receipt_ready", receipt_address: RECEIPTS[n % RECEIPTS.length], state, attempts: 1, next_attempt_at_ms: null, last_status: 204, last_error: null, delivered_at_ms: created + 4 * MIN, created_at_ms: created, updated_at_ms: created, ...extra };
}

export function createFixtureWebhooksSource(mode: WebhooksFixture, evidence: { created: string[] } = { created: [] }): WebhooksSource {
  const endpoints: WebhookEndpoint[] = mode === "fixture" ? [
    endpoint("whk_books", "https://hooks.example.com/chainpay", "Bookkeeping", "active", NOW - 6 * 24 * 60 * MIN),
    endpoint("whk_old", "https://old-hooks.example.net/receipts", null, "disabled", NOW - 20 * 24 * 60 * MIN),
  ] : [];
  const deliveries: Record<string, WebhookDelivery[]> = {
    whk_books: [
      delivery(0, "delivered"),
      delivery(1, "retry_scheduled", { attempts: 3, last_status: 503, last_error: "Receiver answered 503", delivered_at_ms: null, next_attempt_at_ms: NOW + 14 * MIN }),
      delivery(2, "exhausted", { attempts: 8, last_status: null, last_error: "No answer within 10 s (the receiver may still have processed it)", delivered_at_ms: null }),
      delivery(3, "pending", { attempts: 0, last_status: null, delivered_at_ms: null }),
    ],
    whk_old: [],
  };
  const secret = () => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
  const find = (id: string) => { const found = endpoints.find((e) => e.id === id); if (!found) throw new Error("Not found"); return found; };
  return {
    async list() {
      if (mode === "off") throw new WebhooksOffError("off");
      if (mode === "fail") throw new Error("The relay answered 503. Try again.");
      return { subscriptions: endpoints.map((e) => ({ ...e })), max_active: 5, max_attempts: 8 };
    },
    async create(url, description) {
      if (!url.startsWith("https://")) throw new Error("Webhook URLs must use https://");
      if (/localhost|127\.|\[::1\]|169\.254\./.test(url)) throw new Error("This address is not a public internet address");
      const created = endpoint(`whk_new${endpoints.length}`, url, description, "active", Date.now());
      endpoints.unshift(created); deliveries[created.id] = [];
      evidence.created.push(url);
      return { subscription: created, secret: secret() };
    },
    async disable(id) { const e = find(id); e.status = "disabled"; return { ...e }; },
    async rotate(id) {
      const e = find(id); e.previous_secret_expires_at_ms = Date.now() + 24 * 60 * MIN;
      return { subscription: { ...e }, secret: secret(), previous_secret_expires_at_ms: e.previous_secret_expires_at_ms };
    },
    async deliveries(id) { return (deliveries[id] ?? []).map((d) => ({ ...d })); },
    async redeliver(deliveryId) {
      for (const rows of Object.values(deliveries)) {
        const row = rows.find((d) => d.id === deliveryId);
        if (row) { Object.assign(row, { state: "pending", attempts: 0, next_attempt_at_ms: Date.now() }); return { ...row }; }
      }
      throw new Error("Not found");
    },
  };
}
