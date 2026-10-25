/** Isolated PayPal sandbox client for agents. Deliberately no money approval methods. */
export type PayPalDocument = { name: string; text: string };
export type PayPalAgentConfig = { enabled: boolean; apiOrigin: string; workspaceOrigin: string; token: string };

function origin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.hostname.endsWith(".") || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname === "chainpay-relay.vercel.app" || url.hostname === "chainpayai.app" || url.hostname.endsWith(".chainpayai.app")) throw new Error("PayPal requires separate explicit service origins");
  return url.origin;
}
function taskId(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("Invalid PayPal task ID");
  return value;
}
function agentView(value: Record<string, unknown>): Record<string, unknown> {
  const { quote_digest: _quote, share_token: _share, ...view } = value;
  return view;
}
export class PayPalAgentClient {
  #api: string;
  #workspace: string;
  #token: string;
  constructor(config: PayPalAgentConfig) {
    if (config.enabled !== true) throw new Error("PayPal tools are disabled");
    this.#api = origin(config.apiOrigin); this.#workspace = origin(config.workspaceOrigin);
    if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error("A dedicated scoped agent grant is required");
    this.#token = config.token;
  }
  async #request(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.#api}/v1/paypal${path}`, {method, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(35_000), headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : {"Content-Type":"application/json"}) }, body: body === undefined ? undefined : JSON.stringify(body)});
    if (!response.ok) throw new Error(`PayPal workspace request unavailable (${response.status}); retain the original task`);
    if (response.status === 202) return { status: "processing_requested", payment_dispatched: false };
    const reader=response.body?.getReader();
    if(!reader) throw new Error("PayPal workspace response missing");
    const chunks:Uint8Array[]=[];let size=0;
    while(true) {const {done,value}=await reader.read();if(done) break;size+=value.byteLength;if(size>2_000_000){await reader.cancel();throw new Error("PayPal workspace response too large");}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  }
  async requireAgent(): Promise<void> {
    const session = await this.#request("/session");
    if (session.role !== "agent") throw new Error("MCP requires an agent-role grant, never a buyer or merchant approval grant");
  }
  preflight(documents: PayPalDocument[], serviceId = "document-extract-v1", requirements?: string) {
    if (!["document-extract-v1", "document-compare-v1", "requirements-check-v1"].includes(serviceId) || (requirements !== undefined && (typeof requirements !== "string" || new TextEncoder().encode(requirements).length > 4000)) || !Array.isArray(documents) || documents.length < 1 || documents.length > 10 || documents.some(d => !d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some(k => !["name", "text"].includes(k)) || typeof d.name !== "string" || !d.name.trim() || new TextEncoder().encode(d.name).length > 120 || typeof d.text !== "string" || new TextEncoder().encode(d.text).length > 16000)) throw new Error("Invalid preflight inputs");
    return this.#request("/preflight", "POST", {service_id: serviceId, documents, requirements});
  }
  recommendService(objective: string) {
    if (typeof objective !== "string" || !objective.trim() || new TextEncoder().encode(objective).length > 2000) throw new Error("Supply an objective of 1–2000 bytes");
    return this.#request("/recommend-service", "POST", {objective});
  }
  offers() { return this.#request("/offers"); }
  async quote(requestId: string, documents: PayPalDocument[], service?: { id: string; requirements?: string }) {
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(requestId) || !Array.isArray(documents) || documents.length < 1 || documents.length > 10 || documents.some(d => !d || typeof d.name !== "string" || !d.name.trim() || new TextEncoder().encode(d.name).length > 120 || typeof d.text !== "string" || new TextEncoder().encode(d.text).length > 16000)) throw new Error("Invalid document quote; use the same request ID when retrying");
    const result = agentView(await this.#request("/tasks", "POST", {request_id:requestId,documents,...(service ? {service_id:service.id,requirements:service.requirements} : {})}));
    return {...result, review_url:`${this.#workspace}/paypal/?task=${taskId(String(result.id))}`, approval:"Buyer must review the quote and approve PayPal checkout; this tool does not pay."};
  }
  async receipt(id: string) { return agentView(await this.#request(`/tasks/${taskId(id)}`)); }
  process(id: string) { return this.#request(`/tasks/${taskId(id)}/process`,"POST"); }
  async reconcile(id: string) { return agentView(await this.#request(`/tasks/${taskId(id)}/reconcile`,"POST")); }
  async refundProposal(id: string) {
    const {digest:_approval,...proposal}=await this.#request(`/tasks/${taskId(id)}/refund-proposal`);
    return {...proposal,approval:"Merchant review and approval required in the workspace. This tool cannot refund."};
  }
  explain(id: string) { return this.#request(`/tasks/${taskId(id)}/explain`,"POST"); }
}
