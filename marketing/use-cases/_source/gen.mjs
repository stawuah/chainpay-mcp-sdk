// Usage: KIE_API_KEY=... node gen.mjs [id ...]   — submits, polls, downloads to raw/
import fs from "node:fs"; import path from "node:path";
const { default: assets } = await import("./prompts.mjs");
const KEY = process.env.KIE_API_KEY; if (!KEY) throw new Error("KIE_API_KEY missing");
const OUT = path.resolve(".."); fs.mkdirSync(`${OUT}/raw`, { recursive: true });
const MODEL = "gpt-image-2-5-flare-image-to-image";
const H = { Authorization: `Bearer ${KEY}` };
const j = async (r) => { const b = await r.json(); if (b.code !== 200) throw new Error(JSON.stringify(b)); return b.data; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const credit = async () => j(await fetch("https://api.kie.ai/api/v1/chat/credit", { headers: H }));
async function logoUrl(file = path.resolve("../../../frontend/public/brand/chainpay-icon-512.png"), cache = ".logo-url") {
  if (fs.existsSync(cache)) return fs.readFileSync(cache, "utf8");
  const fd = new FormData(); const name = path.basename(file);
  fd.append("file", new Blob([fs.readFileSync(file)], { type: name.endsWith(".jpg") ? "image/jpeg" : "image/png" }), name);
  fd.append("uploadPath", "chainpay-use-cases"); fd.append("fileName", name);
  const d = await j(await fetch("https://kieai.redpandaai.co/api/file-stream-upload", { method: "POST", headers: H, body: fd }));
  const u = d.downloadUrl ?? d.fileUrl; fs.writeFileSync(cache, u); return u;
}
async function run(a, ref) {
  const d = await j(await fetch("https://api.kie.ai/api/v1/jobs/createTask", { method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: { prompt: a.prompt, input_urls: a.robot ? [ref, await logoUrl(path.resolve("../../social-kit/03-square-posts/core/allowance.jpg"), ".robot-url")] : [ref], aspect_ratio: a.aspect, resolution: "2K" } }) }));
  for (let i = 0; i < 150; i++) {
    await sleep(6000);
    const r = await j(await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${d.taskId}`, { headers: H }));
    if (r.state === "success") {
      const url = JSON.parse(r.resultJson).resultUrls[0];
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const n = fs.readdirSync(`${OUT}/raw`).filter(f => f.startsWith(a.id + "-v")).length + 1;
      const f = `${OUT}/raw/${a.id}-v${n}.png`; fs.writeFileSync(f, buf); return f;
    }
    if (r.state === "fail") throw new Error(`${a.id}: ${r.failMsg}`);
  }
  throw new Error(`${a.id}: timeout`);
}
const only = process.argv.slice(2);
const list = only.length ? assets.filter(a => only.includes(a.id)) : assets;
console.log("credits before:", await credit());
const ref = await logoUrl(); console.log("logo ref:", ref);
const res = await Promise.allSettled(list.map(a => run(a, ref).then(f => (console.log("✓", f), f))));
res.filter(r => r.status === "rejected").forEach(r => console.log("✗", r.reason.message));
console.log("credits after:", await credit());
