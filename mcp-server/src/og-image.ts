import { deflateSync } from "node:zlib";

const WIDTH = 1_200;
const HEIGHT = 630;
const CHANNELS = 4;

type Rgba = [number, number, number, number];

const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
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
    const glyph = GLYPHS[character];
    if (!glyph) {
      cursor += scale * 3;
      continue;
    }
    drawGlyph(pixels, glyph, cursor, y, scale, color);
    cursor += scale * 6;
  }
}

function drawCircle(pixels: Buffer, centerX: number, centerY: number, radius: number, color: Rgba): void {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance >= radius - 3 && distance <= radius + 1) setPixel(pixels, x, y, color);
    }
  }
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
  const dark: Rgba = [10, 11, 13, 255];
  const blue: Rgba = [0, 82, 255, 255];
  const white: Rgba = [255, 255, 255, 255];
  const muted: Rgba = [168, 172, 179, 255];

  pixels.fill(255);
  fillRect(pixels, 0, 0, WIDTH, HEIGHT, dark);
  fillRect(pixels, 0, 0, 14, HEIGHT, blue);
  fillRect(pixels, 96, 96, 118, 118, blue);
  drawCircle(pixels, 155, 155, 32, white);
  drawCircle(pixels, 148, 148, 10, white);
  drawWord(pixels, "CHAINPAY", 270, 108, 13, white);
  fillRect(pixels, 270, 235, 510, 4, blue);
  fillRect(pixels, 270, 275, 330, 3, muted);
  fillRect(pixels, 270, 306, 410, 3, muted);
  fillRect(pixels, 270, 337, 270, 3, muted);
  fillRect(pixels, 96, 504, 1_008, 1, [57, 61, 67, 255]);
  fillRect(pixels, 96, 536, 260, 3, blue);

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
