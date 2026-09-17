import express, { type Express, type Request, type Response } from "express";
import type { X402PaymentReferences } from "@chainpay/sdk";
import { customPaymentRequired, type MerchantConfig } from "./config.js";
import { createDeliveryController, type DeliveryController, type DeliveryPublisher } from "./delivery.js";
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
};

export type MerchantApp = Express & {
  waitForDeliveryWork(): Promise<void>;
  delivery: DeliveryController;
};

export function createMerchantApp(
  config: MerchantConfig,
  references: X402PaymentReferences,
  deps: MerchantAppDependencies,
): MerchantApp {
  const challenge = customPaymentRequired(config);
  const delivery = createDeliveryController({
    programId: config.programId,
    publisher: deps.publisher,
  });
  const app = express() as MerchantApp;
  app.disable("x-powered-by");
  app.delivery = delivery;
  app.waitForDeliveryWork = () => delivery.waitForIdle();

  app.get("/healthz", (_request: Request, response: Response) => response.json({ ok: true }));
  app.get("/data", async (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    const paymentHeaders = [
      request.header("payment-signature"),
      request.header("x-payment"),
      request.header("payment-required"),
    ].filter((value): value is string => Boolean(value));

    if (paymentHeaders.length === 0) {
      const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
      return response.status(402).set("X-Payment-Required", encoded).json(challenge);
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
