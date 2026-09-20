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
  assert.match(source, /lazy\(\(\) => import\("\.\/embed\/EmbedOverview"\)\)/);
});

test("shared token UI does not import the dashboard owner layer", async () => {
  // Vite places src/ui in app-shared and src/owner in dashboard. Crossing that
  // boundary made both generated chunks import each other, so AppShell failed
  // before React could render either the landing page or /app.
  const { visited } = await collectSpecifiers("ui/TokenIcon.tsx");
  const ownerModules = [...visited].filter((file) => file.includes("/src/owner/"));
  assert.deepEqual(ownerModules, [], "app-shared token UI must not pull in the dashboard owner chunk");
});

test("a component stylesheet does not restyle the whole app", async () => {
  // record-details.css is imported by RecordDetails.tsx. App-wide selectors in it
  // took effect the moment that component was imported, so one panel restyled the
  // dashboard background, sidebar, card radius and mandate table everywhere.
  // Those rules were app-level intent and now live in styles.css.
  const scoped = await readFile(resolve(root, "ui/record-details.css"), "utf8");
  const appWide = scoped
    .split("\n")
    .filter((line) => /^\s*\.cp-app[\s.]/.test(line));
  assert.deepEqual(appWide, [], "app-wide rules belong in styles.css, not a component stylesheet");

  // Every selector must be the panel/page root or a descendant of it.
  const selectors = scoped
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((block) => block.split("{")[0].trim())
    .filter((selector) => selector && !selector.startsWith("@") && !selector.startsWith("--"));
  for (const selector of selectors) {
    for (const part of selector.split(",").map((value) => value.trim()).filter(Boolean)) {
      assert.match(
        part,
        /^\.cp-(record|permission)-/,
        `"${part}" is not scoped to the record panel`,
      );
    }
  }
});

test("the animation libraries stay out of the every-route chunk", async () => {
  // LandingPage is imported eagerly by AppShell, so a static `import { gsap }`
  // in this hook puts gsap, ScrollTrigger and Lenis — about 120 kB — into a
  // chunk that loads on every route, /verify/<pda> included. That page has no
  // animation and exists for people with no wallet.
  const source = await readFile(resolve(root, "landing/useLandingMotion.ts"), "utf8");

  for (const bare of ['from "gsap"', 'from "gsap/ScrollTrigger"', 'from "lenis"']) {
    const statik = new RegExp(`^\\s*import\\s+(?!type\\b)[^\\n]*${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    assert.equal(statik.test(source), false, `static import of ${bare} would ship it on every route`);
  }

  for (const lazy of ["gsap", "gsap/ScrollTrigger", "lenis"]) {
    assert.match(source, new RegExp(`import\\("${lazy.replace("/", "\\/")}"\\)`));
  }

  // Unmounting before the chunk lands must not leave triggers and a ticker that
  // nothing reverts.
  assert.match(source, /if \(disposed \|\| !root\.current\) return;/);
  assert.match(source, /media\?\.revert\(\)/);
});

test("the verify route renders without mounting WalletController", async () => {
  // /verify/<pda> is the page a finance reader opens with no wallet. Lazy-loading
  // WalletController is not enough if the shell mounts it on every route: the
  // chunk still downloads. The shell must branch before it.
  const source = await readFile(resolve(root, "AppShell.tsx"), "utf8");
  const walletless = source.indexOf("isWalletlessRoute");
  const walletMount = source.indexOf("<WalletController>");
  assert.notEqual(walletless, -1, "AppShell must special-case wallet-free public routes");
  assert.match(source, /kind === "verify"/);
  assert.match(source, /kind === "embed-overview"/);
  assert.ok(
    walletless < walletMount,
    "wallet-free routes must return before WalletController is mounted",
  );
});
