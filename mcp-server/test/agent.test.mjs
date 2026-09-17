import assert from "node:assert/strict";
import test from "node:test";
import { outcomeFromToolResult, runChainPayAgent } from "../dist/agent.js";
import { createDefaultContext } from "../dist/index.js";
import { checkPaymentRequirements } from "../dist/tools/check_payment_requirements.js";

test("AI settlement outcome requires confirmed signature and receipt", () => {
  const failed = outcomeFromToolResult({
    isError: true,
    structuredContent: { action: "backend_relayed", status: "failed", error: "on-chain transaction failed" },
  });
  assert.equal(failed?.kind, "payment_blocked");

  const confirmed = outcomeFromToolResult({
    structuredContent: {
      action: "backend_relayed",
      status: "confirmed",
      signature: "finalized-devnet-signature",
      receiptAddress: "finalized-receipt-pda",
    },
  });
  assert.equal(confirmed?.kind, "payment_settled");

  const managed = outcomeFromToolResult({
    structuredContent: {
      action: "managed_payment_settled",
      status: "confirmed",
      signature: "managed-devnet-signature",
      receiptAddress: "managed-receipt-pda",
    },
  });
  assert.equal(managed?.kind, "payment_settled");

  const pending = outcomeFromToolResult({
    structuredContent: {
      action: "payment_pending",
      paymentId: "payment_123",
      status: "submitted",
      receiptAddress: "pending-receipt-pda",
    },
  });
  assert.equal(pending?.kind, "payment_pending");

  const incomplete = outcomeFromToolResult({
    structuredContent: { action: "backend_relayed", status: "confirmed" },
  });
  assert.equal(incomplete, undefined);
});

test("agent executes an MCP lookup before answering", async () => {
  const previousFetch = globalThis.fetch;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const previousProvider = process.env.CHAINPAY_AI_PROVIDER;
  const previousModel = process.env.CHAINPAY_AGENT_MODEL;
  const mandateAddress = "FmFHfuMx1U6sjKKsuD9SrFedspnAuTUki1KPKjWbehkU";
  let requestCount = 0;

  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.OPENAI_API_KEY;
  process.env.CHAINPAY_AI_PROVIDER = "openrouter";
  process.env.CHAINPAY_AGENT_MODEL = "test-model";
  globalThis.fetch = async (input) => {
    requestCount += 1;
    const body = requestCount === 1
      ? {
        id: "chatcmpl_1",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "get_mandate",
                arguments: JSON.stringify({ address: mandateAddress }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }
      : {
        id: "chatcmpl_2",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "Your mandate is not active.",
            tool_calls: [],
          },
          finish_reason: "stop",
        }],
      };
    assert.equal(new URL(input).pathname, "/api/v1/chat/completions");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await runChainPayAgent(
      { client: { getMandate: async () => null } },
      { message: "Inspect my active mandate", wallet: mandateAddress, mandateAddress },
    );
    assert.equal(requestCount, 2);
    assert.equal(result.message, "Your mandate is not active.");
    assert.deepEqual(result.toolCalls, ["get_mandate"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    if (previousProvider === undefined) delete process.env.CHAINPAY_AI_PROVIDER;
    else process.env.CHAINPAY_AI_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.CHAINPAY_AGENT_MODEL;
    else process.env.CHAINPAY_AGENT_MODEL = previousModel;
  }
});

test("agent asks for payment details before using a payment tool", async () => {
  const previousFetch = globalThis.fetch;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const previousProvider = process.env.CHAINPAY_AI_PROVIDER;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.CHAINPAY_AI_PROVIDER = "openrouter";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("The model must not be called for an incomplete payment request.");
  };

  try {
    const result = await runChainPayAgent(
      { client: {} },
      { message: "Send a payment", wallet: "FmFHfuMx1U6sjKKsuD9SrFedspnAuTUki1KPKjWbehkU" },
    );
    assert.equal(called, false);
    assert.equal(result.outcome.kind, "details_required");
    assert.equal(result.requirements.status, "needs_details");
    assert.ok(result.requirements.missing.includes("payment amount"));
    assert.match(result.message, /missing/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    if (previousProvider === undefined) delete process.env.CHAINPAY_AI_PROVIDER;
    else process.env.CHAINPAY_AI_PROVIDER = previousProvider;
  }
});

test("default MCP context uses only the configured public agent identity", () => {
  const previousPublic = process.env.CHAINPAY_AGENT_PUBLIC_KEY;
  process.env.CHAINPAY_AGENT_PUBLIC_KEY = "FmFHfuMx1U6sjKKsuD9SrFedspnAuTUki1KPKjWbehkU";
  try {
    const context = createDefaultContext();
    assert.equal(context.agentAddress, process.env.CHAINPAY_AGENT_PUBLIC_KEY);
    assert.equal("paymentExecutor" in context, false);
  } finally {
    if (previousPublic === undefined) delete process.env.CHAINPAY_AGENT_PUBLIC_KEY;
    else process.env.CHAINPAY_AGENT_PUBLIC_KEY = previousPublic;
  }
});

test("MCP exposes the same five checks when payment details are missing", async () => {
  const result = await checkPaymentRequirements({ client: {} }, {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action, "details_required");
  assert.equal(result.structuredContent.status, "needs_details");
  assert.deepEqual(result.structuredContent.checks.map((check) => check.key), ["limits", "token", "recipient", "expiry", "policy"]);
  assert.ok(result.structuredContent.missing.length >= 5);
});
