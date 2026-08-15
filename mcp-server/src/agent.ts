import OpenAI from "openai";
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import { callTool, TOOL_DEFINITIONS } from "./index.js";
import type { ChainPayMcpContext } from "./tools/context.js";

const READ_ONLY_TOOL_NAMES = new Set([
  "get_mandate",
  "get_protocol_config",
  "get_asset",
  "get_payment",
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
  history?: AgentHistoryItem[];
};

export type ChainPayAgentResponse = {
  message: string;
  toolCalls: string[];
};

const agentInstructions = `You are the ChainPay assistant inside the user's connected wallet dashboard.

ChainPay is a policy-controlled Solana payment rail. Be concise, clear, and friendly; your answer may be read aloud by a browser. Use the available tools to inspect live ChainPay state when that will answer the user's question. Speak as a capable ChainPay assistant, not as a generic language model.

Safety rules:
- You are read-only in this chat. You may call only the read-only tools provided here.
- Never claim to sign, send, execute, pause, revoke, create, or update anything.
- Never ask for or handle a private key, seed phrase, secret, wallet password, or signed transaction.
- Payment requests must be redirected to the dashboard's payment review and wallet approval flow.
- For “my mandate” or “active mandate”, use the mandate address in the session context.
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

function readOnlyAgentTools(): ChatCompletionTool[] {
  return TOOL_DEFINITIONS
    .filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name))
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

function sessionContext(wallet?: string, mandateAddress?: string): string {
  return [
    "Session context (public values only):",
    wallet ? `Connected wallet: ${wallet}` : "Connected wallet: unavailable",
    mandateAddress ? `Active mandate address: ${mandateAddress}` : "Active mandate address: unavailable",
  ].join("\n");
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
  const history = historyItems(request.history);
  const client = aiClient(provider, apiKey);
  const tools = readOnlyAgentTools();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: agentInstructions },
    ...history.map((item) => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user" as const,
      content: `${sessionContext(wallet, mandateAddress)}\n\nUser request:\n${message}`,
    },
  ];
  const toolCalls: string[] = [];
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
      if (!READ_ONLY_TOOL_NAMES.has(call.function.name)) {
        output = JSON.stringify({ error: "This assistant can only use read-only tools." });
      } else {
        let result: unknown;
        try {
          result = await callTool(context, call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        toolCalls.push(call.function.name);
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
  };
}
