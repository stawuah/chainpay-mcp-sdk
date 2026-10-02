// Usage: node compose.mjs  — newest raw/<id>-vN.png → final/<dir>/<id>.png at exact size, with exact logo lockup top-left
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import sharp from "sharp"; const { default: assets } = await import(process.env.PROMPTS ?? "./prompts.mjs");
const OUT = path.join(process.env.HOME, "Desktop/ChainPay Social");
const BRAND = path.join(process.env.HOME, "Desktop/Colosseum hackathon/chainpay/frontend/public/brand");
const FONT = path.resolve("extras/ttf/Inter-Medium.ttf");

function lockup(h, dark) { // h = tile height px; returns PNG buffer: tile + "ChainPay"
  const txt = `/tmp/cp-word-${h}-${dark}.png`;
  execFileSync("magick", ["-background", "none", "-fill", dark ? "#FFFFFF" : "#14213D", "-font", FONT,
    "-pointsize", String(Math.round(h * 0.62)), "-kerning", String(-h * 0.012), "label:ChainPay", "-trim", txt]);
  return { txt, h };
}
for (const a of assets) {
  const raws = fs.existsSync(`${OUT}/raw`) ? fs.readdirSync(`${OUT}/raw`).filter(f => f.startsWith(a.id + "-v")).sort((x, y) => parseInt(x.split("-v")[1]) - parseInt(y.split("-v")[1])) : [];
  if (!raws.length) { console.log("skip (no raw)", a.id); continue; }
  const [W, H] = a.out;
  const base = await sharp(`${OUT}/raw/${raws.at(-1)}`).resize(W, H, { fit: "cover", position: "centre" }).toBuffer();
  const pad = Math.round(Math.min(W, H) * 0.06), th = Math.round(Math.max(36, Math.min(W, H) * (a.dir === "reddit" ? 0.16 : 0.075)));
  const corner = await sharp(base).extract({ left: pad, top: pad, width: th * 5, height: th }).stats();
  const [r, , b] = corner.channels.map(c => c.mean);
  const dark = r < 150 && b > r + 40; // brand-blue background
  const sym = fs.readFileSync(`${BRAND}/chainpay-symbol.svg`, "utf8").replace('stroke="#0052ff"', 'stroke="#ffffff"');
  const tile = dark
    ? await sharp(Buffer.from(sym)).resize(th, th).toBuffer()
    : await sharp(`${BRAND}/chainpay-icon-512.png`).resize(th, th).toBuffer();
  const { txt } = lockup(th, dark);
  const word = await sharp(txt).resize({ height: Math.round(th * 0.5) }).toBuffer();
  const wm = await sharp(word).metadata();
  fs.mkdirSync(`${OUT}/final/${a.dir}`, { recursive: true });
  await sharp(base).composite([
    { input: tile, left: pad, top: pad },
    { input: word, left: pad + Math.round(th * 1.3), top: pad + Math.round((th - wm.height) / 2) },
  ]).png().toFile(`${OUT}/final/${a.dir}/${a.id}.png`);
  console.log("✓", `${a.dir}/${a.id}.png`, `${W}x${H}`, dark ? "(white wordmark)" : "(ink wordmark)", "from", raws.at(-1));
}
// profile pics: exact icon, no generation
fs.mkdirSync(`${OUT}/final/x`, { recursive: true }); fs.mkdirSync(`${OUT}/final/reddit`, { recursive: true });
await sharp(`${BRAND}/chainpay-icon-512.png`).resize(400, 400).toFile(`${OUT}/final/x/x-profile.png`);
await sharp(`${BRAND}/chainpay-icon-512.png`).resize(256, 256).toFile(`${OUT}/final/reddit/reddit-icon.png`);
console.log("✓ profile icons");
