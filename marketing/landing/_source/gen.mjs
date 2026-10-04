// Hero lane for the landing (ruling: _bmad-output/design-council/landing-brand-ruling-2026-10-04.md, B7 and prompts 1 and 2).
// Usage: KIE_API_KEY=... node gen.mjs still [count]       → ../raw/hero-still-vN.png (GPT Image 2.5, 16:9)
//        KIE_API_KEY=... node gen.mjs video <still.png> [count] → ../raw/hero-video-vN.mp4 (Seedance 2.0 Mini, first = last frame)
import fs from "node:fs"; import path from "node:path";
import { STILL, MOTION } from "./prompts.mjs";
const KEY = process.env.KIE_API_KEY; if (!KEY) throw new Error("KIE_API_KEY missing");
const RAW = path.resolve("../raw"); fs.mkdirSync(RAW, { recursive: true });
const H = { Authorization: `Bearer ${KEY}` };
const j = async (r) => { const b = await r.json(); if (b.code !== 200) throw new Error(JSON.stringify(b)); return b.data; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

async function upload(file) {
  const cache = `.${path.basename(file)}-url`;
  if (fs.existsSync(cache)) return fs.readFileSync(cache, "utf8");
  const fd = new FormData(); const name = path.basename(file);
  fd.append("file", new Blob([fs.readFileSync(file)], { type: MIME[path.extname(name)] }), name);
  fd.append("uploadPath", "chainpay-landing"); fd.append("fileName", name);
  const d = await j(await fetch("https://kieai.redpandaai.co/api/file-stream-upload", { method: "POST", headers: H, body: fd }));
  const u = d.downloadUrl ?? d.fileUrl; fs.writeFileSync(cache, u); return u;
}

async function task(model, input, prefix, ext, n) {
  const d = await j(await fetch("https://api.kie.ai/api/v1/jobs/createTask", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ model, input }) }));
  for (let i = 0; i < 200; i++) {
    await sleep(6000);
    const r = await j(await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${d.taskId}`, { headers: H }));
    if (r.state === "success") {
      const url = JSON.parse(r.resultJson).resultUrls[0];
      const f = `${RAW}/${prefix}-v${n}.${ext}`;
      fs.writeFileSync(f, Buffer.from(await (await fetch(url)).arrayBuffer())); return f;
    }
    if (r.state === "fail") throw new Error(`${prefix}: ${r.failMsg}`);
  }
  throw new Error(`${prefix}: timeout`);
}

// Version numbers are reserved up front so parallel takes never overwrite each other.
const next = (prefix) => fs.readdirSync(RAW).filter(f => f.startsWith(prefix + "-v")).length + 1;
const [mode, arg, countArg] = process.argv.slice(2);
const pub = path.resolve("../../../frontend/public/use-cases");
let jobs;
if (mode === "still") {
  const refs = [await upload(`${pub}/one-tap-stop-1600.webp`), await upload(`${pub}/receipts-for-accounting-1600.webp`)];
  const base = next("hero-still");
  jobs = Array.from({ length: Number(arg ?? 2) }, () => (i) =>
    task("gpt-image-2-5-flare-image-to-image", { prompt: STILL, input_urls: refs, aspect_ratio: "16:9", resolution: "2K" }, "hero-still", "png", base + i));
} else if (mode === "video") {
  const frame = await upload(path.resolve(arg));
  const base = next("hero-video");
  jobs = Array.from({ length: Number(countArg ?? 2) }, () => (i) =>
    task("bytedance/seedance-2-mini", { prompt: MOTION, first_frame_url: frame, last_frame_url: frame, aspect_ratio: "16:9", resolution: "720p", duration: 8, generate_audio: false }, "hero-video", "mp4", base + i));
} else throw new Error("mode: still | video");
const res = await Promise.allSettled(jobs.map((f, i) => f(i).then(p => (console.log("✓", p), p))));
res.filter(r => r.status === "rejected").forEach(r => console.log("✗", r.reason.message));
