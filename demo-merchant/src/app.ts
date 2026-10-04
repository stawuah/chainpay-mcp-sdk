import express, { type Express, type Request, type Response } from "express";
import type { X402PaymentReferences } from "@chainpay/sdk";
import { paymentRequiredForConfig, type MerchantConfig } from "./config.js";
import { mountCardShops, type CardShopDependencies } from "./card-shops.js";
import { createDeliveryController, type DeliveryController, type DeliveryPublisher } from "./delivery.js";
import {
  MandateRequestLookupError,
  PAY_WITH_CHAINPAY_HTML,
  createMandateRequest,
  type MandateRequestDependencies,
  type MandateRequestSettings,
} from "./mandate-requests.js";
import {
  detectAndParsePaymentHeader,
  inspectPaymentHeader,
  logSafeProofEvent,
  publicProofErrorBody,
  verifyMerchantProof,
  type MerchantVerificationDependencies,
} from "./proof.js";

export type MerchantAppDependencies = MerchantVerificationDependencies & {
  publisher?: DeliveryPublisher;
  /** Absent in production without a seller key: the endpoint answers 503. */
  mandateRequests?: { settings: MandateRequestSettings; lookup: MandateRequestDependencies };
  /** Sandbox card shops (workstream D). Pages always mount; checkout needs settings. */
  cardShops?: CardShopDependencies;
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export type MerchantApp = Express & {
  waitForDeliveryWork(): Promise<void>;
  delivery: DeliveryController;
};

export function createMerchantApp(
  config: MerchantConfig,
  references: X402PaymentReferences,
  deps: MerchantAppDependencies,
): MerchantApp {
  const challenge = paymentRequiredForConfig(config);
  const delivery = createDeliveryController({
    programId: config.programId,
    publisher: deps.publisher,
  });
  const app = express() as MerchantApp;
  app.disable("x-powered-by");
  app.delivery = delivery;
  app.waitForDeliveryWork = () => delivery.waitForIdle();

  app.get("/healthz", (_request: Request, response: Response) => response.json({ ok: true }));
  app.get("/", (_request: Request, response: Response) => {
    response
      .set({ "Content-Security-Policy": PAGE_CSP, "Cache-Control": "no-store" })
      .type("html")
      .send(PAY_WITH_CHAINPAY_HTML);
  });
  mountCardShops(app, deps.cardShops);
  app.post("/mandate-requests", express.json({ limit: "2kb" }), async (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    const configured = deps.mandateRequests;
    if (!configured) {
      return response.status(503).json({ error: "Mandate requests need CHAINPAY_SELLER_SECRET_KEY on this host." });
    }
    const body: unknown = request.body;
    const requested = body && typeof body === "object" && "poNumber" in body ? (body as { poNumber: unknown }).poNumber : undefined;
    if (requested !== undefined && typeof requested !== "string") {
      return response.status(400).json({ error: "poNumber must be text" });
    }
    try {
      const created = await createMandateRequest(configured.settings, config, configured.lookup, {
        ...(requested === undefined ? {} : { poNumber: requested }),
      });
      return response.json({ link: created.link, summary: created.summary });
    } catch (error) {
      if (error instanceof MandateRequestLookupError) {
        return response.status(502).json({ error: error.message });
      }
      return response.status(400).json({ error: error instanceof Error ? error.message : "Request is invalid" });
    }
  });
  app.get("/data", async (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    const paymentHeaders = [
      request.header("payment-signature"),
      request.header("x-payment"),
      request.header("payment-required"),
    ].filter((value): value is string => Boolean(value));

    if (paymentHeaders.length === 0) {
      const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
      const headers: Record<string, string> = { "X-Payment-Required": encoded };
      if ("x402Version" in challenge && challenge.x402Version === 2) {
        headers["PAYMENT-REQUIRED"] = encoded;
      }
      return response.status(402).set(headers).json(challenge);
    }

    try {
      const standardHeader = paymentHeaders.find((header) => inspectPaymentHeader(header).kind === "standard-v2");
      if (standardHeader) {
        detectAndParsePaymentHeader(standardHeader);
      }
      const proofHeader = request.header("x-payment") ?? paymentHeaders[0];
      const proof = detectAndParsePaymentHeader(proofHeader);
      const verified = await verifyMerchantProof(config, references, proof, deps);
      delivery.sendPaid(response, {
        data: "Premium resource content",
        paidWith: verified.receipt.address,
        transactionSignature: verified.transactionSignature,
      }, verified.receipt.address);
    } catch (error) {
      const mapped = publicProofErrorBody(error);
      logSafeProofEvent(mapped.body.code, {
        signature: paymentHeaders[0] ? inspectSafeSignature(paymentHeaders[0]) : undefined,
      });
      if (!response.headersSent) {
        response.status(mapped.status).json(mapped.body);
      }
    }
  });

  return app;
}

function inspectSafeSignature(header: string): string | undefined {
  try {
    const detected = inspectPaymentHeader(header);
    if (detected.kind === "custom") return detected.proof.payload.signature;
  } catch {
    return undefined;
  }
  return undefined;
}
