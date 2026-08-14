import assert from "node:assert/strict";
import test from "node:test";
import { runChainPayAgent } from "../dist/agent.js";

test("read-only agent executes an MCP lookup before answering", async () => {
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
