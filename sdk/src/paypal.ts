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
export type PayPalPurchaseItem = { id: string; qty: number };
function catalogId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,40}$/.test(value)) throw new Error("Invalid catalog, merchant or allowance ID");
  return value;
}
function purchaseItems(value: unknown): PayPalPurchaseItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 || value.some(i => !i || typeof i !== "object" || Array.isArray(i) || Object.keys(i).some(k => !["id", "qty"].includes(k)) || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 10)) throw new Error("Items must be 1–10 lines of {id, qty} with qty 1–10");
  return value.map(i => ({ id: catalogId(i.id), qty: i.qty as number }));
}
function agentView(value: Record<string, unknown>): Record<string, unknown> {
  // The vault block holds the buyer's PayPal token ids; an agent never gets to see it.
  const { quote_digest: _quote, share_token: _share, vault: _vault, ...view } = value;
  if (Array.isArray(view.refunds)) view.refunds = view.refunds.map((refund: Record<string, unknown>) => { const {digest: _digest, ...readOnly} = refund; return readOnly; });
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
    let response: Response;
    try {
      response = await fetch(`${this.#api}/v1/paypal${path}`, {method, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(35_000), headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : {"Content-Type":"application/json"}) }, body: body === undefined ? undefined : JSON.stringify(body)});
    } catch (cause) {
      // No answer is not a failure: the request may have landed. Never open a new task over it.
      if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) throw new Error("No response from the PayPal workspace yet; keep the original task and check it again, do not create another");
      throw cause;
    }
    if (!response.ok) {
      // The server always sends {"error": "..."}; pass that reason on so the agent can act on it.
      let reason = "";
      try { const text = await response.text(); const parsed = JSON.parse(text.slice(0, 2_000)); if (typeof parsed?.error === "string") reason = parsed.error; } catch { /* body was not JSON */ }
      throw new Error(`${reason || "PayPal workspace request unavailable"} (${response.status}); retain the original task`);
    }
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
  allowance() { return this.#request("/subscriptions"); }
  async consumeAllowance(id: string, subscriptionId: string, delegationId: string) {
    await this.requireAgent();
    const task = await this.#request(`/tasks/${taskId(id)}`);
    if (typeof task.quote_digest !== "string") throw new Error("Original quote digest unavailable");
    return agentView(await this.#request(`/tasks/${taskId(id)}/allowance`, "POST", {subscription_id: taskId(subscriptionId), delegation_id: taskId(delegationId), digest: task.quote_digest}));
  }
  offers() { return this.#request("/offers"); }
  async quote(requestId: string, documents: PayPalDocument[], service?: { id: string; requirements?: string }) {
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(requestId) || !Array.isArray(documents) || documents.length < 1 || documents.length > 10 || documents.some(d => !d || typeof d.name !== "string" || !d.name.trim() || new TextEncoder().encode(d.name).length > 120 || typeof d.text !== "string" || new TextEncoder().encode(d.text).length > 16000)) throw new Error("Invalid document quote; use the same request ID when retrying");
    const result = agentView(await this.#request("/tasks", "POST", {request_id:requestId,documents,...(service ? {service_id:service.id,requirements:service.requirements} : {})}));
    return {...result, review_url:`${this.#workspace}/paypal/?task=${taskId(String(result.id))}`, approval:"Buyer must review the quote and approve PayPal checkout; this tool does not pay."};
  }
  async receipt(id: string) { return agentView(await this.#request(`/tasks/${taskId(id)}`)); }
  async resolution(id: string) { const receipt = await this.receipt(id); return { units: Array.isArray(receipt.units) ? receipt.units.map((u: Record<string, unknown>) => ({index:u.index, revision:u.revision ?? 0, output_hash:u.output_hash ?? null, buyer_review:u.buyer_review ?? null})) : [], resolution: receipt.resolution ?? [], revisions: receipt.revisions ?? [], refunds: receipt.refunds ?? [], approval: "Buyer decisions and merchant approvals require the human workspace. Acceptance never waives PayPal dispute rights." }; }
  process(id: string) { return this.#request(`/tasks/${taskId(id)}/process`,"POST"); }
  async reconcile(id: string) { return agentView(await this.#request(`/tasks/${taskId(id)}/reconcile`,"POST")); }
  async refundProposal(id: string) {
    const {digest:_approval,...proposal}=await this.#request(`/tasks/${taskId(id)}/refund-proposal`);
    return {...proposal,approval:"Merchant review and approval required in the workspace. This tool cannot refund."};
  }
  explain(id: string) { return this.#request(`/tasks/${taskId(id)}/explain`,"POST"); }
  async findAllowance() {
    const result = await this.#request("/allowances");
    return { ...result, allowances: Array.isArray(result.allowances) ? result.allowances.map((a: Record<string, unknown>) => agentView(a)) : [] };
  }
  searchCatalog(q?: string) {
    if (q !== undefined && (typeof q !== "string" || new TextEncoder().encode(q).length > 200)) throw new Error("Catalog search text must be at most 200 bytes");
    return this.#request(q === undefined || !q.trim() ? "/catalog" : `/catalog?q=${encodeURIComponent(q)}`);
  }
  async quotePurchase(input: { merchant: string; items: PayPalPurchaseItem[]; allowance_id?: string }) {
    return this.#request("/purchases/quote", "POST", { merchant: catalogId(input.merchant), items: purchaseItems(input.items), ...(input.allowance_id === undefined ? {} : { allowance_id: catalogId(input.allowance_id) }) });
  }
  async purchase(requestId: string, allowanceId: string, merchant: string, items: PayPalPurchaseItem[]) {
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(requestId)) throw new Error("request_id of 16–64 chars is required; reuse it when retrying");
    const body = { request_id: requestId, allowance_id: catalogId(allowanceId), merchant: catalogId(merchant), items: purchaseItems(items) };
    const receipt = agentView(await this.#request("/purchases", "POST", body));
    const purchase = (receipt.purchase ?? {}) as Record<string, unknown>;
    const policy = (purchase.policy ?? {}) as Record<string, unknown>;
    const kind = policy.allowed === false ? "refused" : purchase.approval === "requested" ? "approval_requested" : "receipt";
    return { kind, ...(kind === "refused" ? { reason_code: policy.reason_code } : {}), review_url: `${this.#workspace}/paypal/?task=${taskId(String(receipt.id))}`, receipt };
  }
  async listApprovals() {
    const result = await this.#request("/purchases/approvals");
    return { ...result, approvals: Array.isArray(result.approvals) ? result.approvals.map((r: Record<string, unknown>) => agentView(r)) : [] };
  }
  async requestRefund(id: string, reason: string) {
    if (typeof reason !== "string" || !reason.trim() || new TextEncoder().encode(reason).length > 2000) throw new Error("Supply a refund reason of 1–2000 bytes");
    const { digest: _approval, ...request } = await this.#request(`/tasks/${taskId(id)}/refund-request`, "POST", { reason });
    return { ...request, approval: "Merchant review and approval required in the workspace. This tool cannot refund." };
  }
}
