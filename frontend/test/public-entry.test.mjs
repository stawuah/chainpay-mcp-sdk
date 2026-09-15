import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const blocked = [
  "@chainpay/sdk",
  "@solana/web3.js",
  "./wallet.ts",
  "wallet/connect",
  "config/client",
  "owner/runtime",
];

function importsIn(source) {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

async function walk(file, seen = new Set()) {
  const full = resolve(root, file);
  if (seen.has(full)) return seen;
  seen.add(full);
  let source;
  try {
    source = await readFile(full, "utf8");
  } catch {
    return seen;
  }
  for (const specifier of importsIn(source)) {
    if (!specifier.startsWith(".")) continue;
    const next = specifier.endsWith(".ts") || specifier.endsWith(".tsx") || specifier.endsWith(".css") || specifier.endsWith(".png") || specifier.endsWith(".jpg")
      ? specifier
      : `${specifier}.tsx`;
    const resolved = resolve(dirname(full), next);
    const rel = resolved.startsWith(root) ? resolved.slice(root.length + 1) : resolved;
    await walk(rel.replace(/\.tsx$/, "") + (resolved.endsWith(".tsx") || resolved.endsWith(".ts") ? resolved.slice(resolved.lastIndexOf(".")) : ".tsx"), seen);
  }
  return seen;
}

async function collectSpecifiers(entry) {
  const source = await readFile(resolve(root, entry), "utf8");
  const specifiers = importsIn(source);
  const relative = specifiers.filter((value) => value.startsWith("."));
  const files = [source];
  for (const specifier of relative) {
    const candidates = [
      resolve(root, dirname(entry), specifier),
      resolve(root, dirname(entry), `${specifier}.ts`),
      resolve(root, dirname(entry), `${specifier}.tsx`),
    ];
    for (const candidate of candidates) {
      try {
        files.push(await readFile(candidate, "utf8"));
        break;
      } catch {
        // try next extension
      }
    }
  }
  return { specifiers, bundle: files.join("\n") };
}

test("landing module graph does not import wallet, SDK client, or owner runtime", async () => {
  const { specifiers, bundle } = await collectSpecifiers("landing/LandingPage.tsx");
  assert.equal(specifiers.some((value) => value.includes("@chainpay/sdk")), false);
  assert.equal(specifiers.some((value) => value.includes("@solana")), false);
  assert.equal(specifiers.some((value) => value.includes("config/client")), false);
  assert.equal(specifiers.some((value) => value.includes("wallet/connect")), false);
  assert.equal(specifiers.some((value) => value.includes("owner/runtime")), false);
  for (const needle of blocked) {
    assert.equal(bundle.includes(needle), false, `landing graph leaked ${needle}`);
  }
});

test("AppShell does not statically import wallet connect or SDK client", async () => {
  const source = await readFile(resolve(root, "AppShell.tsx"), "utf8");
  const specifiers = importsIn(source);
  assert.equal(specifiers.includes("@chainpay/sdk"), false);
  assert.equal(specifiers.some((value) => value.includes("config/client")), false);
  assert.equal(specifiers.some((value) => value.includes("wallet/connect")), false);
  assert.match(source, /lazy\(\(\) => import\("\.\/wallet\/WalletController"\)\)/);
  assert.match(source, /lazy\(\(\) => import\("\.\/dashboard\/AppWorkspace"\)\)/);
  assert.match(source, /lazy\(\(\) => import\("\.\/verify\/VerifyPage"\)\)/);
});
