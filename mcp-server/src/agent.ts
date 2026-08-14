import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
} from "openai/resources/responses/responses.js";
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
const MAX_HISTORY_ITEMS = 8;

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

ChainPay is a policy-controlled Solana payment rail. Be concise, clear, and friendly; your answer may be read aloud by a browser. Use the available tools to inspect live ChainPay state when that will answer the user's question.

Safety rules:
- You are read-only in this chat. You may call only the read-only tools provided here.
- Never claim to sign, send, execute, pause, revoke, create, or update anything.
- Never ask for or handle a private key, seed phrase, secret, wallet password, or signed transaction.
- Payment requests must be redirected to the dashboard's payment review and wallet approval flow.
- For “my mandate” or “active mandate”, use the mandate address in the session context.
- For receipt questions, ask for a receipt address if one was not supplied.
- If a tool says data was not found, say that plainly and suggest the next safe dashboard step.
- Use human-readable explanations and do not expose internal chain-of-thought.`;

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

function readOnlyAgentTools(): FunctionTool[] {
  return TOOL_DEFINITIONS
    .filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      // Read-only schemas include optional receipt lookup fields. Non-strict
      // validation lets the model omit fields that are not relevant to a query.
      strict: false,
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

function functionCalls(response: { output: Array<{ type: string }> }): ResponseFunctionToolCall[] {
  return response.output.filter(
    (item): item is ResponseFunctionToolCall => item.type === "function_call",
  );
}

export async function runChainPayAgent(
  context: ChainPayMcpContext,
  request: ChainPayAgentRequest,
): Promise<ChainPayAgentResponse> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("The ChainPay AI agent is not configured. Set OPENAI_API_KEY on the MCP server.");
  }

  const message = requiredMessage(request.message);
  const wallet = publicContext(request.wallet, "wallet");
  const mandateAddress = publicContext(request.mandateAddress, "mandateAddress");
  const history = historyItems(request.history);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tools = readOnlyAgentTools();
  const input: ResponseInput = [
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

  let response = await client.responses.create({
    model: process.env.CHAINPAY_AGENT_MODEL ?? "gpt-5-mini",
    instructions: agentInstructions,
    input,
    tools,
    parallel_tool_calls: false,
    max_output_tokens: 700,
    store: false,
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = functionCalls(response);
    if (calls.length === 0) break;

    const outputs = await Promise.all(calls.map(async (call) => {
      if (!READ_ONLY_TOOL_NAMES.has(call.name)) {
        return {
          type: "function_call_output" as const,
          call_id: call.call_id,
          output: JSON.stringify({ error: "This assistant can only use read-only tools." }),
        };
      }

      let result: unknown;
      try {
        result = await callTool(context, call.name, JSON.parse(call.arguments) as Record<string, unknown>);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      toolCalls.push(call.name);
      return {
        type: "function_call_output" as const,
        call_id: call.call_id,
        output: toolOutput(result),
      };
    }));

    const continuation: ResponseInput = [
      ...(response.output as ResponseInput),
      ...outputs,
    ];
    response = await client.responses.create({
      model: process.env.CHAINPAY_AGENT_MODEL ?? "gpt-5-mini",
      instructions: agentInstructions,
      input: continuation,
      tools,
      parallel_tool_calls: false,
      max_output_tokens: 700,
      store: false,
    });
  }

  return {
    message: response.output_text.trim() || "I could not find a text response for that request.",
    toolCalls,
  };
}
