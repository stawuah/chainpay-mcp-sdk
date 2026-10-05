// Owner webhooks API (docs/guides/owner-webhooks.md). Owner session only; the
// relay answers 404 on every route while webhooks are switched off.
import { BACKEND_URL } from "../../config/public";
import { authorizedFetch } from "../../session";

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  status: "active" | "disabled";
  created_at_ms: number;
  updated_at_ms: number;
  /** While a rotation overlaps, when the previous secret stops signing. */
  previous_secret_expires_at_ms: number | null;
};

export type WebhookDeliveryState = "pending" | "delivering" | "delivered" | "retry_scheduled" | "exhausted";

export type WebhookDelivery = {
  id: string;
  event_id: string;
  event_type: string;
  receipt_address: string;
  state: WebhookDeliveryState;
  attempts: number;
  next_attempt_at_ms: number | null;
  last_status: number | null;
  last_error: string | null;
  delivered_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type WebhookList = { subscriptions: WebhookEndpoint[]; max_active: number; max_attempts: number };
export type CreatedEndpoint = { subscription: WebhookEndpoint; secret: string };
export type RotatedSecret = { subscription: WebhookEndpoint; secret: string; previous_secret_expires_at_ms: number | null };

export interface WebhooksSource {
  list(): Promise<WebhookList>;
  create(url: string, description: string | null): Promise<CreatedEndpoint>;
  disable(id: string): Promise<WebhookEndpoint>;
  rotate(id: string): Promise<RotatedSecret>;
  deliveries(id: string): Promise<WebhookDelivery[]>;
  redeliver(deliveryId: string): Promise<WebhookDelivery>;
}

/** The relay has webhooks switched off (every route answers 404). */
export class WebhooksOffError extends Error {}

const base = () => BACKEND_URL.replace(/\/$/, "");

/** The relay's error sentence, without its internal category prefix. */
async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const raw = typeof body?.error === "string" ? body.error : "";
  const message = raw.replace(/^(bad request|operation conflict|forbidden): /, "");
  if (response.status === 429) return new Error("Too many changes in a minute. Try again shortly.");
  if (response.status === 401) return new Error("Sign in again to manage webhooks.");
  return new Error(message || `The relay answered ${response.status}. Try again.`);
}

async function request<T>(path: string, init: RequestInit = {}, mode: "interactive" | "passive" = "interactive"): Promise<T> {
  const response = await authorizedFetch(`${base()}${path}`, init, undefined, mode);
  if (response.status === 404 && path === "/v1/webhooks") throw new WebhooksOffError("Webhooks are not switched on for this relay.");
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}

const post = (body?: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const liveWebhooksSource: WebhooksSource = {
  list: () => request<WebhookList>("/v1/webhooks", {}, "passive"),
  create: (url, description) => request<CreatedEndpoint>("/v1/webhooks", post({ url, description })),
  disable: async (id) => (await request<{ subscription: WebhookEndpoint }>(`/v1/webhooks/${encodeURIComponent(id)}/disable`, post())).subscription,
  rotate: (id) => request<RotatedSecret>(`/v1/webhooks/${encodeURIComponent(id)}/rotate`, post()),
  deliveries: async (id) => (await request<{ deliveries: WebhookDelivery[] }>(`/v1/webhooks/${encodeURIComponent(id)}/deliveries?limit=10`, {}, "passive")).deliveries,
  redeliver: async (id) => (await request<{ delivery: WebhookDelivery }>(`/v1/webhook-deliveries/${encodeURIComponent(id)}/redeliver`, post())).delivery,
};

let override: WebhooksSource | null = null;
/** Test and design-harness hook. Production never sets it. */
export function setWebhooksSourceOverride(source: WebhooksSource | null) { override = source; }
export function webhooksSource(): WebhooksSource { return override ?? liveWebhooksSource; }
