// Usage: KIE_API_KEY=... node animate.mjs [id ...]  → ~/Desktop/ChainPay Social/motion/raw/<id>-vN.mp4
import fs from "node:fs"; import path from "node:path";
import clips from "./motion.mjs";
const KEY = process.env.KIE_API_KEY; if (!KEY) throw new Error("KIE_API_KEY missing");
const ROOT = path.join(process.env.HOME, "Desktop/ChainPay Social"); const OUT = `${ROOT}/motion/raw`; fs.mkdirSync(OUT, { recursive: true });
const H = { Authorization: `Bearer ${KEY}` };
const j = async (r) => { const b = await r.json(); if (b.code !== 200) throw new Error(JSON.stringify(b)); return b.data; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const credit = async () => j(await fetch("https://api.kie.ai/api/v1/chat/credit", { headers: H }));
async function upload(file) {
  const fd = new FormData(); const name = path.basename(file);
  fd.append("file", new Blob([fs.readFileSync(file)], { type: "image/png" }), name);
  fd.append("uploadPath", "chainpay-motion"); fd.append("fileName", name);
  const d = await j(await fetch("https://kieai.redpandaai.co/api/file-stream-upload", { method: "POST", headers: H, body: fd }));
  return d.downloadUrl ?? d.fileUrl;
}
async function run(c) {
  const url = await upload(`${ROOT}/final/${c.src}`);
  const d = await j(await fetch("https://api.kie.ai/api/v1/jobs/createTask", { method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bytedance/seedance-2-mini", input: { prompt: c.prompt, first_frame_url: url, last_frame_url: url,
      resolution: "720p", aspect_ratio: "adaptive", duration: 5, generate_audio: false, web_search: false } }) }));
  for (let i = 0; i < 200; i++) {
    await sleep(8000);
    const r = await j(await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${d.taskId}`, { headers: H }));
    if (r.state === "success") {
      const v = JSON.parse(r.resultJson).resultUrls[0];
      const n = fs.readdirSync(OUT).filter(f => f.startsWith(c.id + "-v")).length + 1;
      const f = `${OUT}/${c.id}-v${n}.mp4`; fs.writeFileSync(f, Buffer.from(await (await fetch(v)).arrayBuffer())); return f;
    }
    if (r.state === "fail") throw new Error(`${c.id}: ${r.failMsg}`);
  }
  throw new Error(`${c.id}: timeout`);
}
const only = process.argv.slice(2); const list = only.length ? clips.filter(c => only.includes(c.id)) : clips;
const before = await credit(); console.log("credits before:", before);
const res = await Promise.allSettled(list.map(c => run(c).then(f => (console.log("✓", f), f))));
res.filter(r => r.status === "rejected").forEach(r => console.log("✗", r.reason.message));
const after = await credit(); console.log("credits after:", after, "| used:", (before - after).toFixed(1));
