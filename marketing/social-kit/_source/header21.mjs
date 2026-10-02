// 21:9 header source (1680x720) whose centre 1680x560 band crops to the 3:1 X header, lockup placed inside that band.
import sharp from "sharp"; import fs from "node:fs"; import { execFileSync } from "node:child_process";
const R = process.env.HOME + "/Desktop/ChainPay Social"; const B = process.env.HOME + "/Desktop/Colosseum hackathon/chainpay/frontend/public/brand";
const base = await sharp(`${R}/raw/x-header-v1.png`).resize(1680, 720, { fit: "cover" }).toBuffer();
const th = 42, pad = 34, top = 80 + pad;
const sym = fs.readFileSync(`${B}/chainpay-symbol.svg`, "utf8").replace('stroke="#0052ff"', 'stroke="#ffffff"');
execFileSync("magick", ["-background", "none", "-fill", "#FFFFFF", "-font", "extras/ttf/Inter-Medium.ttf", "-pointsize", "26", "label:ChainPay", "-trim", "/tmp/cp-hdr.png"]);
const word = await sharp("/tmp/cp-hdr.png").resize({ height: 21 }).toBuffer(); const wm = await sharp(word).metadata();
fs.mkdirSync(`${R}/motion`, { recursive: true });
await sharp(base).composite([{ input: await sharp(Buffer.from(sym)).resize(th, th).toBuffer(), left: pad, top },
  { input: word, left: pad + Math.round(th * 1.3), top: top + Math.round((th - wm.height) / 2) }]).png().toFile(`${R}/motion/x-header-21x9.png`);
