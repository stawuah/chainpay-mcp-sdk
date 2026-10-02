/** Runtime service credential, never a Convex deploy key or a browser token. */
export class ConvexStorage {
  private readonly endpoint: string;
  constructor(siteUrl: string, private readonly secret: string) {
    const url = new URL(siteUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/" || secret.length < 32) {
      throw new Error("Invalid Convex URL or service credential");
    }
    this.endpoint = `${url.origin}/internal/storage/v1`;
  }

  async call<T>(operation: string, args: Record<string, unknown>): Promise<T> {
    // No automatic retry: an interrupted mutation can already have committed.
    const response = await fetch(this.endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, args }),
    }).catch(() => { throw new Error("Storage outcome uncertain; reconcile the original operation"); });
    if (!response.ok) throw new Error(`Storage request rejected (${response.status})`);
    const body = await response.json() as { value?: T };
    if (!Object.hasOwn(body, "value")) throw new Error("Invalid storage response");
    return body.value as T;
  }
}
