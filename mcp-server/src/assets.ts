import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
};

export type StaticAsset = {
  body: Buffer;
  contentType: string;
};

function loadAsset(relativePath: string): StaticAsset {
  const body = readFileSync(join(PACKAGE_ROOT, relativePath));
  const ext = relativePath.slice(relativePath.lastIndexOf("."));
  return { body, contentType: MIME[ext] ?? "application/octet-stream" };
}

const cache = new Map<string, StaticAsset>();

export function getStaticAsset(routePath: string): StaticAsset | undefined {
  const map: Record<string, string> = {
    "/assets/brands/usdc.svg": "assets/brands/usdc.svg",
    "/assets/brands/solana.svg": "assets/brands/solana.svg",
    "/assets/brands/pyusd.png": "assets/brands/pyusd.png",
  };
  const relative = map[routePath];
  if (!relative) return undefined;
  if (!cache.has(relative)) cache.set(relative, loadAsset(relative));
  return cache.get(relative);
}
