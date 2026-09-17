import {
  defaultTrustedSellerMapping,
  signDeliveryAttestation,
  verifyDeliveryAttestation,
  type SignedDeliveryAttestation,
} from "@chainpay/sdk";
import type { SellerPublishConfig } from "./config.js";
import type { DeliveryPublishInput, DeliveryPublisher } from "./delivery.js";

const POST_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [200, 800] as const;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_048;

export type DeliveryFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type AxumPublisherDependencies = {
  fetchImpl?: DeliveryFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (event: string, details?: { receipt?: string; status?: string }) => void;
};

/**
 * Signs a response-served envelope once with the SDK helpers, then POSTs the
 * identical bytes to Axum. Retries never change servedAt or the signature.
 */
export function createAxumDeliveryPublisher(
  config: SellerPublishConfig,
  deps: AxumPublisherDependencies = {},
): DeliveryPublisher {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logSafeDeliveryEvent;
  const collectionUrl = `${config.backendUrl}/v1/delivery-attestations`;

  return {
    async publish(input: DeliveryPublishInput) {
      const existing = await getExisting(fetchImpl, collectionUrl, input.receiptAddress, log);
      const prior = existing ? await classifyExisting(existing, config, input) : "absent";
      if (prior === "reuse") {
        log("delivery_statement_reused", { receipt: input.receiptAddress });
        return;
      }
      if (prior === "conflict") {
        log("delivery_statement_conflict", { receipt: input.receiptAddress });
        return;
      }

      const servedAt = now().toISOString();
      const envelope = await signDeliveryAttestation({
        version: 1,
        statement: "chainpay.response-served",
        cluster: "devnet",
        programId: input.programId,
        receiptAddress: input.receiptAddress,
        seller: config.seller,
        contentHash: input.contentHash,
        servedAt,
      }, config.secretKey);
      const body = JSON.stringify({
        payload: envelope.payload,
        signature: envelope.signature,
      });

      await postIdenticalEnvelope(fetchImpl, sleep, log, {
        collectionUrl,
        receiptAddress: input.receiptAddress,
        contentHash: input.contentHash,
        config,
        body,
      });
    },
  };
}

export function logSafeDeliveryEvent(
  event: string,
  details: { receipt?: string; status?: string } = {},
): void {
  const receipt = details.receipt ? ` receipt=${details.receipt}` : "";
  const status = details.status ? ` status=${details.status}` : "";
  process.stderr.write(`demo-merchant ${event}${receipt}${status}\n`);
}

type ExistingVerdict = "reuse" | "conflict" | "absent";

async function classifyExisting(
  dto: unknown,
  config: SellerPublishConfig,
  input: DeliveryPublishInput,
): Promise<ExistingVerdict> {
  const envelope = envelopeFromPublicDto(dto);
  if (!envelope) return "absent";
  const verified = await verifyDeliveryAttestation(envelope, {
    trustedSellers: defaultTrustedSellerMapping([config.seller], config.programId),
    programId: config.programId,
  });
  if (!verified.valid || !verified.payload) return "absent";
  if (
    verified.payload.seller !== config.seller
    || verified.payload.receiptAddress !== input.receiptAddress
    || verified.payload.programId !== config.programId
  ) {
    return "conflict";
  }
  if (verified.payload.contentHash !== input.contentHash) return "conflict";
  return "reuse";
}

function envelopeFromPublicDto(value: unknown): SignedDeliveryAttestation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!("payload" in record) || typeof record.signature !== "string") return undefined;
  return { payload: record.payload as SignedDeliveryAttestation["payload"], signature: record.signature };
}

async function getExisting(
  fetchImpl: DeliveryFetch,
  collectionUrl: string,
  receiptAddress: string,
  log: AxumPublisherDependencies["log"],
): Promise<unknown | undefined> {
  try {
    const response = await fetchImpl(`${collectionUrl}/${encodeURIComponent(receiptAddress)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      log?.("delivery_statement_lookup_failed", { receipt: receiptAddress, status: String(response.status) });
      return undefined;
    }
    return await readBoundedJson(response);
  } catch {
    log?.("delivery_statement_lookup_failed", { receipt: receiptAddress });
    return undefined;
  }
}

async function postIdenticalEnvelope(
  fetchImpl: DeliveryFetch,
  sleep: (ms: number) => Promise<void>,
  log: AxumPublisherDependencies["log"],
  input: {
    collectionUrl: string;
    receiptAddress: string;
    contentHash: string;
    config: SellerPublishConfig;
    body: string;
  },
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < POST_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 800);
    try {
      const response = await fetchImpl(input.collectionUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: input.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 409) {
        const existing = await getExisting(fetchImpl, input.collectionUrl, input.receiptAddress, log);
        const verdict = existing
          ? await classifyExisting(existing, input.config, {
            receiptAddress: input.receiptAddress,
            contentHash: input.contentHash,
            body: Buffer.alloc(0),
            programId: input.config.programId,
            cluster: "devnet",
          })
          : "absent";
        if (verdict === "reuse") {
          log?.("delivery_statement_reused", { receipt: input.receiptAddress, status: "409" });
          return;
        }
        if (verdict === "conflict") {
          log?.("delivery_statement_conflict", { receipt: input.receiptAddress, status: "409" });
          return;
        }
        lastError = new Error("delivery_publish_http_409");
        log?.("delivery_statement_lookup_failed", { receipt: input.receiptAddress, status: "409" });
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`delivery_publish_http_${response.status}`);
        log?.("delivery_publish_retry", { receipt: input.receiptAddress, status: String(response.status) });
        continue;
      }
      if (!response.ok) {
        log?.("delivery_publish_rejected", { receipt: input.receiptAddress, status: String(response.status) });
        throw new Error(`delivery_publish_http_${response.status}`);
      }
      const dto = await readBoundedJson(response);
      const verdict = await classifyExisting(dto, input.config, {
        receiptAddress: input.receiptAddress,
        contentHash: input.contentHash,
        body: Buffer.alloc(0),
        programId: input.config.programId,
        cluster: "devnet",
      });
      if (verdict !== "reuse") {
        log?.("delivery_statement_mismatch", { receipt: input.receiptAddress, status: String(response.status) });
        throw new Error("delivery_publish_hash_mismatch");
      }
      log?.("delivery_statement_published", { receipt: input.receiptAddress, status: String(response.status) });
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith("delivery_publish_http_")) {
        const status = Number(error.message.slice("delivery_publish_http_".length));
        if (status && status < 500 && status !== 429) throw error;
      }
      if (error instanceof Error && error.message === "delivery_publish_hash_mismatch") throw error;
      log?.("delivery_publish_retry", { receipt: input.receiptAddress });
    }
  }
  log?.("delivery_publish_failed", { receipt: input.receiptAddress });
  throw lastError instanceof Error ? lastError : new Error("delivery_publish_failed");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("delivery_publish_empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel("oversized");
      throw new Error("delivery_publish_oversized");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
