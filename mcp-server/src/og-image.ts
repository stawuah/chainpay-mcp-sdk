import { deflateSync } from "node:zlib";

const WIDTH = 1_200;
const HEIGHT = 630;
const CHANNELS = 4;

type Rgba = [number, number, number, number];

/** Minimal 7-row bitmap for lowercase chainpay wordmark on OG card. */
const LOWER: Record<string, string[]> = {
  a: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  c: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  h: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  i: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  n: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  p: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};

function setPixel(pixels: Buffer, x: number, y: number, color: Rgba): void {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const offset = (y * WIDTH + x) * CHANNELS;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function fillRect(pixels: Buffer, x: number, y: number, width: number, height: number, color: Rgba): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) setPixel(pixels, column, row, color);
  }
}

function fillRoundedRect(pixels: Buffer, x: number, y: number, size: number, radius: number, color: Rgba): void {
  fillRect(pixels, x + radius, y, size - radius * 2, size, color);
  fillRect(pixels, x, y + radius, size, size - radius * 2, color);
  for (let row = 0; row < radius; row += 1) {
    for (let column = 0; column < radius; column += 1) {
      const corners = [
        [x + radius - column - 1, y + radius - row - 1],
        [x + size - radius + column, y + radius - row - 1],
        [x + radius - column - 1, y + size - radius + row],
        [x + size - radius + column, y + size - radius + row],
      ] as const;
      if (Math.hypot(column - radius + 0.5, row - radius + 0.5) <= radius) {
        for (const [px, py] of corners) setPixel(pixels, px, py, color);
      }
    }
  }
}

function drawGlyph(pixels: Buffer, glyph: string[], x: number, y: number, scale: number, color: Rgba): void {
  glyph.forEach((row, rowIndex) => {
    [...row].forEach((pixel, columnIndex) => {
      if (pixel === "1") fillRect(pixels, x + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
    });
  });
}

function drawWord(pixels: Buffer, word: string, x: number, y: number, scale: number, color: Rgba): void {
  let cursor = x;
  for (const character of word) {
    const glyph = LOWER[character];
    if (!glyph) {
      cursor += scale * 3;
      continue;
    }
    drawGlyph(pixels, glyph, cursor, y, scale, color);
    cursor += scale * 6;
  }
}

/** Thick white stroke segment for the connection hook mark. */
function strokeLine(pixels: Buffer, x0: number, y0: number, x1: number, y1: number, width: number, color: Rgba): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    fillRect(pixels, x - width / 2, y - width / 2, width, width, color);
  }
}

function drawIconTile(pixels: Buffer, x: number, y: number, size: number): void {
  const blue: Rgba = [0, 82, 255, 255];
  const white: Rgba = [255, 255, 255, 255];
  const radius = Math.round(size * (40 / 180));
  fillRoundedRect(pixels, x, y, size, radius, blue);
  const scale = size / 180;
  const ox = x + 18 * scale;
  const oy = y + 18 * scale;
  const s = scale * 0.8;
  const stroke = Math.max(6, Math.round(28 * s));
  strokeLine(pixels, ox + 116 * s, oy + 30 * s, ox + 90 * s, oy + 30 * s, stroke, white);
  strokeLine(pixels, ox + 90 * s, oy + 30 * s, ox + 65 * s, oy + 55 * s, stroke, white);
  strokeLine(pixels, ox + 65 * s, oy + 55 * s, ox + 34 * s, oy + 80 * s, stroke, white);
  strokeLine(pixels, ox + 34 * s, oy + 80 * s, ox + 65 * s, oy + 110 * s, stroke, white);
  const cx = x + size / 2;
  const cy = y + size / 2;
  strokeLine(pixels, cx + 26 * s, cy - 30 * s, cx, cy - 30 * s, stroke, white);
  strokeLine(pixels, cx, cy - 30 * s, cx - 26 * s, cy - 5 * s, stroke, white);
  strokeLine(pixels, cx - 26 * s, cy - 5 * s, cx - 56 * s, cy + 20 * s, stroke, white);
  strokeLine(pixels, cx - 56 * s, cy + 20 * s, cx - 25 * s, cy + 50 * s, stroke, white);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  checksum.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, checksum]);
}

export function createChainPayOgImage(): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * CHANNELS, 255);
  const canvas: Rgba = [248, 249, 251, 255];
  const card: Rgba = [255, 255, 255, 255];
  const ink: Rgba = [20, 33, 61, 255];
  const body: Rgba = [86, 100, 125, 255];
  const line: Rgba = [219, 226, 239, 255];
  const blue: Rgba = [0, 82, 255, 255];

  fillRect(pixels, 0, 0, WIDTH, HEIGHT, canvas);
  fillRect(pixels, 72, 96, 1056, 438, card);
  fillRect(pixels, 72, 96, 1056, 1, line);
  fillRect(pixels, 72, 533, 1056, 1, line);
  fillRect(pixels, 72, 96, 1, 438, line);
  fillRect(pixels, 1127, 96, 1, 438, line);

  drawIconTile(pixels, 128, 210, 168);
  drawWord(pixels, "chainpay", 340, 248, 11, ink);
  fillRect(pixels, 340, 318, 420, 4, blue);
  fillRect(pixels, 340, 350, 560, 3, body);
  fillRect(pixels, 340, 378, 480, 3, body);
  fillRect(pixels, 128, 430, 944, 1, line);
  fillRect(pixels, 128, 458, 240, 3, blue);

  const scanlines = Buffer.alloc(HEIGHT * (WIDTH * CHANNELS + 1));
  for (let row = 0; row < HEIGHT; row += 1) {
    const target = row * (WIDTH * CHANNELS + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, row * WIDTH * CHANNELS, (row + 1) * WIDTH * CHANNELS);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
