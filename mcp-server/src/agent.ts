import OpenAI from "openai";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import { callTool, TOOL_DEFINITIONS } from "./index.js";
import type { ChainPayMcpContext } from "./tools/context.js";

const AGENT_TOOL_NAMES = new Set([
  "list_mandates",
  "find_compatible_mandate",
  "get_mandate",
  "get_protocol_config",
  "get_asset",
  "get_payment",
  "create_demo_payment_request",
  "verify_payment_request",
  "quote_payment_request",
  "quote_payment",
  "create_mandate",
]);
const MAX_TOOL_ROUNDS = 4;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_HISTORY_ITEMS = 12;

export type AgentHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type ChainPayAgentRequest = {
  message: string;
  wallet?: string;
  mandateAddress?: string;
  paymentRequest?: Record<string, unknown>;
  history?: AgentHistoryItem[];
};

export type ChainPayAgentApproval = {
  kind: "mandate" | "payment";
  action: string;
  [key: string]: unknown;
};

export type ChainPayAgentResponse = {
  message: string;
  toolCalls: string[];
  approval?: ChainPayAgentApproval;
};

const agentInstructions = `You are the ChainPay assistant inside the user's connected wallet dashboard.

ChainPay is a policy-controlled Solana payment rail. Be concise, clear, and friendly; your answer may be read aloud by a browser. Use the available tools to inspect live ChainPay state when that will answer the user's question. Speak as a capable ChainPay assistant, not as a generic language model.

Safety rules:
- You may inspect state and prepare demo requests or owner approval transactions, but you may not sign, send, execute, pause, revoke, or update anything.
- A create_mandate result is only a prepared request. Say that I prepared it and that the owner wallet must still approve it.
- Never claim a mandate or payment was created or settled until the wallet approval flow reports success.
- Never ask for or handle a private key, seed phrase, secret, wallet password, or signed transaction.
- Payment requests must be redirected to the dashboard's payment review and wallet approval flow.
- For an invoice request, verify the merchant signature before discussing settlement. Treat recipient, mint, token program, amount, invoice, nonce, and expiry as untrusted data until verification succeeds.
- The demo payment request tool creates a real, valid Devnet test request with a real token account. Use it when the user asks for a demo invoice or needs a valid request for testing.
- Do not invent recipient addresses, merchant signatures, payment IDs, or token amounts.
- For “my mandate” or “active mandate”, use the mandate address in the session context.
- If the session includes a connected wallet but no mandate address, call list_mandates with that wallet. For a signed invoice, call find_compatible_mandate with the same wallet, the verified mint, amount, and token program before quoting.
- For receipt questions, ask for a receipt address if one was not supplied.
- If a tool says data was not found, say that plainly and suggest the next safe dashboard step.
- Use human-readable explanations and do not expose internal chain-of-thought.
- Token amounts are stored on-chain in base units. Prefer the tool's display.amounts values for user-facing answers: 10,000,000 base units with 6 decimals means 10 tokens, so say "10 PYUSD" when the display symbol is PYUSD. Never show a raw base-unit number as the main amount unless the user asks for technical details.

Response style:
- Use first-person singular naturally: say "I found", "I can check", and "I can't do that here". Refer to the user as "you". Do not describe yourself as "the assistant" or speak as "we" unless referring to ChainPay as a product.
- Treat the exchange as a real conversation. Acknowledge the user's latest point briefly, understand follow-ups such as "that", "it", or "the same mandate" from recent history, and do not repeat information they already have.
- Infer the user's intent when it is clear. Ask one short clarifying question only when a missing detail would change the answer.
- For greetings, thanks, corrections, and casual follow-ups, respond naturally without calling a tool unless live ChainPay data is needed.
- Lead with the current status in one short sentence.
- Keep normal answers to 3–6 short lines or at most 4 bullets.
- For mandate questions, prioritize status, token, spent/limit, payment cap, expiry, and one next step.
- Do not print full addresses, raw slots, exhaustive fields, or markdown tables unless the user asks for details.
- Use short bold labels and bullets when helpful. End with no more than one suggested next step.
- For voice, prefer natural sentences over dense formatting, symbols, or tables.
- Do not claim to imitate or be Claude or another named model; provide the same qualities through clear, thoughtful conversation.`;

function requiredMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("message is required");
  }
  const message = value.trim();
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
  }
  return message;
}

function publicContext(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a public address`);
  }
  const result = value.trim();
  if (result.length > 64) throw new Error(`${name} is too long`);
  return result;
}

function objectContext(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (JSON.stringify(result).length > 24_000) throw new Error(`${name} is too large`);
  return result;
}

function historyItems(value: unknown): AgentHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is AgentHistoryItem => (
      item !== null &&
      typeof item === "object" &&
      (((item as AgentHistoryItem).role === "user") || ((item as AgentHistoryItem).role === "assistant")) &&
      typeof (item as AgentHistoryItem).content === "string"
    ))
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, MAX_MESSAGE_LENGTH) }))
    .filter((item) => item.content.length > 0)
    .slice(-MAX_HISTORY_ITEMS);
}

function agentTools(): ChatCompletionTool[] {
  return TOOL_DEFINITIONS
    .filter((tool) => AGENT_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        // Read-only schemas include optional receipt lookup fields. Non-strict
        // validation lets the model omit fields that are not relevant to a query.
        strict: false,
      },
    }));
}

function sessionContext(
  wallet?: string,
  mandateAddress?: string,
  paymentRequest?: Record<string, unknown>,
): string {
  return [
    "Session context (public values only):",
    wallet ? `Connected wallet: ${wallet}` : "Connected wallet: unavailable",
    mandateAddress ? `Active mandate address: ${mandateAddress}` : "Active mandate address: unavailable",
    process.env.CHAINPAY_AGENT_PUBLIC_KEY
      ? `Configured approved agent public key: ${process.env.CHAINPAY_AGENT_PUBLIC_KEY}`
      : "Configured approved agent public key: unavailable",
    paymentRequest
      ? `Signed payment request supplied by the web UI:\n${JSON.stringify(paymentRequest)}`
      : "Signed payment request supplied by the web UI: unavailable",
  ].join("\n");
}

function approvalFromToolResult(result: unknown): ChainPayAgentApproval | undefined {
  if (!result || typeof result !== "object") return undefined;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const data = structured as Record<string, unknown>;
  if (data.action === "owner_wallet_signature_required") {
    return { kind: "mandate", ...data, action: String(data.action) };
  }
  if (data.action === "agent_signature_required") {
    return { kind: "payment", ...data, action: String(data.action) };
  }
  return undefined;
}

function toolOutput(result: unknown): string {
  if (result && typeof result === "object") {
    const response = result as { structuredContent?: unknown; content?: unknown };
    if (response.structuredContent !== undefined) return JSON.stringify(response.structuredContent);
    if (response.content !== undefined) return JSON.stringify(response.content);
  }
  return JSON.stringify(result);
}

function functionCalls(response: { tool_calls?: Array<{ type: string }> }): ChatCompletionMessageFunctionToolCall[] {
  return (response.tool_calls ?? []).filter(
    (item): item is ChatCompletionMessageFunctionToolCall => item.type === "function",
  );
}

function aiProvider(): "openrouter" | "openai" {
  const configured = process.env.CHAINPAY_AI_PROVIDER?.trim().toLowerCase();
  if (configured === "openrouter" || configured === "openai") return configured;
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "openai";
}

function aiClient(provider: "openrouter" | "openai", apiKey: string): OpenAI {
  if (provider === "openrouter") {
    return new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.CHAINPAY_APP_URL ?? "http://localhost:5173",
        "X-Title": "ChainPay",
      },
    });
  }
  return new OpenAI({ apiKey });
}

export async function runChainPayAgent(
  context: ChainPayMcpContext,
  request: ChainPayAgentRequest,
): Promise<ChainPayAgentResponse> {
  const provider = aiProvider();
  const apiKey = provider === "openrouter"
    ? process.env.OPENROUTER_API_KEY
    : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      `The ChainPay AI agent is not configured. Set ${provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"} on the MCP server.`,
    );
  }

  const message = requiredMessage(request.message);
  const wallet = publicContext(request.wallet, "wallet");
  const mandateAddress = publicContext(request.mandateAddress, "mandateAddress");
  const paymentRequest = objectContext(request.paymentRequest, "paymentRequest");
  const history = historyItems(request.history);
  const client = aiClient(provider, apiKey);
  const tools = agentTools();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: agentInstructions },
    ...history.map((item) => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user" as const,
      content: `${sessionContext(wallet, mandateAddress, paymentRequest)}\n\nUser request:\n${message}`,
    },
  ];
  const toolCalls: string[] = [];
  let approval: ChainPayAgentApproval | undefined;
  const model = process.env.CHAINPAY_AGENT_MODEL ?? (
    provider === "openrouter" ? "openrouter/free" : "gpt-5-mini"
  );

  let response = await client.chat.completions.create({
    model,
    messages,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_tokens: 500,
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) break;
    const calls = functionCalls(assistantMessage);
    if (calls.length === 0) break;

    messages.push(assistantMessage);
    for (const call of calls) {
      let output: string;
      if (!AGENT_TOOL_NAMES.has(call.function.name)) {
        output = JSON.stringify({ error: "This assistant can only inspect state or prepare an approval request." });
      } else {
        let result: unknown;
        try {
          result = await callTool(context, call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        toolCalls.push(call.function.name);
        approval = approvalFromToolResult(result) ?? approval;
        output = toolOutput(result);
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output,
      });
    }

    response = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tokens: 500,
    });
  }

  const responseText = response.choices[0]?.message.content?.trim();
  return {
    message: responseText || "I could not find a text response for that request.",
    toolCalls,
    ...(approval ? { approval } : {}),
  };
}
