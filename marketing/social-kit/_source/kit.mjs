// Copies final PNGs into the repo kit as JPGs, organized by platform/theme. Writes manifest.json for the README.
import fs from "node:fs"; import path from "node:path"; import sharp from "sharp";
const SRC = path.join(process.env.HOME, "Desktop/ChainPay Social/final");
const DST = process.argv[2];
const [p1, p2, p3] = await Promise.all(["./prompts.mjs", "./prompts2.mjs", "./prompts3.mjs"].map(f => import(f).then(m => m.default)));
const line = (a) => a?.prompt.match(/headline reads "([^"]+)"/)?.[1] ?? "";
const all = Object.fromEntries([...p1, ...p2, ...p3].map(a => [a.id, a]));
// id -> [folder, group title]
const MAP = {
  "x-header": ["01-profile-and-banners/x", "Banners"], "fb-cover": ["01-profile-and-banners/facebook", "Banners"], "reddit-banner": ["01-profile-and-banners/reddit", "Banners"],
  "x-profile": ["01-profile-and-banners/x", "Profile icons"], "reddit-icon": ["01-profile-and-banners/reddit", "Profile icons"],
};
const theme = {
  core: ["allowance", "keys", "nope", "receipts", "flow", "rails"],
  capabilities: ["x402", "mcp", "tokens", "solana", "crossmint-soon", "per-call", "spend-bar", "verify", "no-card"],
  control: ["pause", "modes", "revoke", "cap", "expires", "human-loop", "owned"],
  culture: ["meme-lunch", "meme-card", "meme-receipts", "meme-habits", "meme-only-2", "meme-understood", "gm"],
};
const themeOf = (id) => Object.entries(theme).find(([, ks]) => ks.includes(id.replace(/^(square|x-post|fb-post)-/, "")))?.[0];
const out = [];
for (const dir of fs.readdirSync(SRC).filter(d => !d.startsWith("."))) for (const f of fs.readdirSync(`${SRC}/${dir}`).filter(f => f.endsWith(".png"))) {
  const id = f.replace(".png", ""); let folder, group;
  if (MAP[id]) [folder, group] = MAP[id];
  else if (id === "square-crossmint-live") [folder, group] = ["99-hold-not-yet-accurate", "Hold"];
  else if (dir === "instagram-story") [folder, group] = ["04-instagram-stories", "Stories"];
  else if (dir === "instagram-carousel") [folder, group] = ["05-carousels/how-chainpay-works", "Carousel: how ChainPay works"];
  else if (dir === "instagram-carousel-x402") [folder, group] = ["05-carousels/x402-explained", "Carousel: x402 explained"];
  else { const t = themeOf(id); const kind = dir === "square" ? "03-square-posts" : "02-wide-posts";
    [folder, group] = [`${kind}/${t}`, `${kind.startsWith("03") ? "Square" : "Wide"} · ${t}`]; }
  const name = id.replace(/^(square|x-post|fb-post|story|carousel-x402|carousel)-/, (m) => m.startsWith("carousel") ? "slide-" : "");
  const rel = `${folder}/${name}.jpg`;
  fs.mkdirSync(`${DST}/${folder}`, { recursive: true });
  const img = sharp(`${SRC}/${dir}/${f}`); const m = await img.metadata();
  await img.flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" }).toFile(`${DST}/${rel}`);
  out.push({ rel, group, line: line(all[id]), size: `${m.width}×${m.height}` });
}
out.sort((a, b) => a.rel.localeCompare(b.rel));
fs.writeFileSync("manifest.json", JSON.stringify(out, null, 1));
console.log(out.length, "files"); for (const o of out) console.log(o.rel, o.size, "|", o.line);
