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

// Resolve a relative specifier the way the bundler would, so the walk below
// follows real files instead of guessing an extension.
async function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      const source = await readFile(candidate, "utf8");
      return { file: candidate, source };
    } catch {
      // try the next extension
    }
  }
  return null;
}

// Walk the whole module graph, not just one level. A one-level check passes even
// when a leaf two hops down pulls in the SDK, which is exactly the leak this
// test exists to catch.
async function collectSpecifiers(entry) {
  const entryFile = resolve(root, entry);
  const seen = new Set();
  const specifiers = [];
  const files = [];

  async function visit(file, source) {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(source);
    for (const specifier of importsIn(source)) {
      specifiers.push(specifier);
      if (!specifier.startsWith(".")) continue;
      if (/\.(css|png|jpe?g|svg|webp)$/.test(specifier)) continue;
      const resolved = await resolveSpecifier(file, specifier);
      if (resolved) await visit(resolved.file, resolved.source);
    }
  }

  await visit(entryFile, await readFile(entryFile, "utf8"));
  return { specifiers, bundle: files.join("\n"), visited: seen };
}

test("landing module graph does not import wallet, SDK client, or owner runtime", async () => {
  const { specifiers, bundle, visited } = await collectSpecifiers("landing/LandingPage.tsx");
  // Guard the guard: if resolution silently failed we would be asserting over a
  // single file and calling the graph clean.
  assert.ok(visited.size >= 2, `expected to walk the landing graph, visited ${visited.size} file(s)`);
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

test("the verify route renders without mounting WalletController", async () => {
  // /verify/<pda> is the page a finance reader opens with no wallet. Lazy-loading
  // WalletController is not enough if the shell mounts it on every route: the
  // chunk still downloads. The shell must branch before it.
  const source = await readFile(resolve(root, "AppShell.tsx"), "utf8");
  const verifyBranch = source.indexOf('currentRoute.kind === "verify"');
  const walletMount = source.indexOf("<WalletController>");
  assert.notEqual(verifyBranch, -1, "AppShell must special-case the verify route");
  assert.ok(
    verifyBranch < walletMount,
    "the verify route must return before WalletController is mounted",
  );
});
