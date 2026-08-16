const services = [
  ["frontend", process.env.CHAINPAY_FRONTEND_URL ?? "https://chainpay-frontend.onrender.com"],
  ["backend", process.env.CHAINPAY_BACKEND_URL ?? "https://chainpay-backend.onrender.com/healthz"],
  ["mcp", process.env.CHAINPAY_MCP_URL ?? "https://chainpay-mcp.onrender.com/healthz"],
];

const parsedTimeout = Number.parseInt(process.env.CHAINPAY_KEEPALIVE_TIMEOUT_SECONDS ?? "20", 10);
const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout * 1000 : 20_000;
const timestamp = new Date().toISOString();

async function ping(name, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "ChainPay keep-alive cron" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return { name, url, ok: true };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(services.map(([name, url]) => ping(name, url)));
for (const result of results) {
  if (result.ok) {
    console.log("[" + timestamp + "] " + result.name + " OK       " + result.url);
  } else {
    console.error("[" + timestamp + "] " + result.name + " FAILED   " + result.url + " · " + result.error);
  }
}

process.exitCode = results.every((result) => result.ok) ? 0 : 1;
