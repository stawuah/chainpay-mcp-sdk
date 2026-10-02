import sharp from "sharp"; import fs from "node:fs";
// Rasterize each logo to a padded 1024 PNG on white (references for GPT Image)
for (const f of fs.readdirSync("logos").filter(f => /\.(svg|png)$/.test(f) && !f.startsWith("ref-"))) {
  const img = sharp(`logos/${f}`, { density: 600 }).resize(820, 820, { fit: "inside" });
  const buf = await img.png().toBuffer(); const m = await sharp(buf).metadata();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#ffffff" } })
    .composite([{ input: buf, left: (1024 - m.width) >> 1, top: (1024 - m.height) >> 1 }]).png().toFile(`logos/ref-${f.replace(/\.\w+$/, "")}.png`);
}
