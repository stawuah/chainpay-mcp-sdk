import assert from "node:assert/strict";
import test from "node:test";
import { runChainPayAgent } from "../dist/agent.js";

test("read-only agent executes an MCP lookup before answering", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.CHAINPAY_AGENT_MODEL;
  const mandateAddress = "FmFHfuMx1U6sjKKsuD9SrFedspnAuTUki1KPKjWbehkU";
  let requestCount = 0;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.CHAINPAY_AGENT_MODEL = "test-model";
  globalThis.fetch = async () => {
    requestCount += 1;
    const body = requestCount === 1
      ? {
        id: "resp_1",
        output: [{
          id: "fc_1",
          type: "function_call",
          name: "get_mandate",
          call_id: "call_1",
          arguments: JSON.stringify({ address: mandateAddress }),
          status: "completed",
        }],
        output_text: "",
      }
      : {
        id: "resp_2",
        output: [{
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Your mandate is not active." }],
        }],
        output_text: "Your mandate is not active.",
      };
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
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CHAINPAY_AGENT_MODEL;
    else process.env.CHAINPAY_AGENT_MODEL = previousModel;
  }
});
