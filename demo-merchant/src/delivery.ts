import { createHash, createPrivateKey, sign as signEd25519 } from "node:crypto";
import type { Response } from "express";

export type ResponseServedPayload = {
  version: 1;
  statement: "chainpay.response-served";
  cluster: "devnet";
  programId: string;
  receiptAddress: string;
  seller: string;
  contentHash: string;
  servedAt: string;
};

export type SignedDeliveryEnvelope = {
  payload: ResponseServedPayload;
  signature: string;
};

export type DeliveryPublishInput = {
  receiptAddress: string;
  contentHash: string;
  body: Buffer;
  programId: string;
  cluster: "devnet";
};

/**
 * Optional PR-07 hook. The demo merchant does not POST to Axum.
 * A later backend publisher can attach here and reuse identical signed bytes.
 */
export type DeliveryPublisher = {
  publish(input: DeliveryPublishInput): Promise<void>;
};

export type DeliveryController = {
  sendPaid(response: Response, body: unknown, receiptAddress: string): void;
  waitForIdle(): Promise<void>;
  publishedReceipts(): string[];
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function serializeJsonBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDeliveryPayload(payload: ResponseServedPayload): string {
  return JSON.stringify({
    version: 1,
    statement: "chainpay.response-served",
    cluster: payload.cluster,
    programId: payload.programId,
    receiptAddress: payload.receiptAddress,
    seller: payload.seller,
    contentHash: payload.contentHash,
    servedAt: payload.servedAt,
  });
}

export function buildResponseServedPayload(input: {
  programId: string;
  receiptAddress: string;
  seller: string;
  contentHash: string;
  servedAt?: string;
}): ResponseServedPayload {
  if (!SHA256_HEX.test(input.contentHash)) {
    throw new Error("contentHash must be lowercase SHA-256 hex");
  }
  return {
    version: 1,
    statement: "chainpay.response-served",
    cluster: "devnet",
    programId: input.programId,
    receiptAddress: input.receiptAddress,
    seller: input.seller,
    contentHash: input.contentHash,
    servedAt: input.servedAt ?? new Date().toISOString(),
  };
}

/** Merchant-only Ed25519 signing. Tests may pass a generated fixture key. */
export function signResponseServedEnvelope(
  payload: ResponseServedPayload,
  secretKey: Uint8Array,
): SignedDeliveryEnvelope {
  const seed = secretKey.length === 64 ? secretKey.subarray(0, 32) : secretKey;
  if (seed.length !== 32) throw new Error("seller secret key must be 32 or 64 bytes");
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const signature = signEd25519(null, Buffer.from(canonicalDeliveryPayload(payload), "utf8"), key);
  return { payload, signature: signature.toString("base64") };
}

type LifecycleTarget = {
  statusCode: number;
  once(event: "finish" | "close", listener: () => void): unknown;
};

/**
 * Hash exact representation bytes, attach finish/close listeners, then the caller sends those bytes.
 * Only HTTP 200 `finish` may publish. Early close, 402, and missing publisher publish nothing.
 */
export function bindServedResponseLifecycle(
  response: LifecycleTarget,
  input: {
    contentHash: string;
    receiptAddress: string;
    programId: string;
    publisher?: DeliveryPublisher;
    body: Buffer;
    onWork?: (work: Promise<void>) => void;
  },
): void {
  let finished = false;
  let aborted = false;
  response.once("close", () => {
    if (!finished) aborted = true;
  });
  response.once("finish", () => {
    finished = true;
    if (aborted || response.statusCode !== 200 || !input.publisher) return;
    const work = input.publisher.publish({
      receiptAddress: input.receiptAddress,
      contentHash: input.contentHash,
      body: input.body,
      programId: input.programId,
      cluster: "devnet",
    }).catch(() => {
      // Publication failure leaves the statement missing; Paid is unchanged.
    });
    input.onWork?.(work);
  });
}

export function createDeliveryController(options: {
  programId: string;
  publisher?: DeliveryPublisher;
}): DeliveryController {
  const issued = new Set<string>();
  const inflight = new Map<string, Promise<void>>();
  let tail: Promise<void> = Promise.resolve();

  const gatedPublisher: DeliveryPublisher | undefined = options.publisher
    ? {
      async publish(input) {
        if (issued.has(input.receiptAddress)) return;
        const existing = inflight.get(input.receiptAddress);
        if (existing) {
          await existing;
          return;
        }
        const work = options.publisher!.publish(input).then(() => {
          issued.add(input.receiptAddress);
        }).finally(() => {
          inflight.delete(input.receiptAddress);
        });
        inflight.set(input.receiptAddress, work);
        await work;
      },
    }
    : undefined;

  function track(work: Promise<void>): void {
    tail = tail.then(() => work).catch(() => undefined);
  }

  return {
    sendPaid(response: Response, body: unknown, receiptAddress: string): void {
      const bytes = serializeJsonBody(body);
      const contentHash = sha256Hex(bytes);
      bindServedResponseLifecycle(response, {
        contentHash,
        receiptAddress,
        programId: options.programId,
        publisher: gatedPublisher,
        body: bytes,
        onWork: track,
      });
      response.status(200);
      response.set("Cache-Control", "no-store");
      response.set("Content-Type", "application/json; charset=utf-8");
      response.set("Content-Length", String(bytes.byteLength));
      response.end(bytes);
    },
    waitForIdle() {
      return tail;
    },
    publishedReceipts() {
      return [...issued];
    },
  };
}
