#!/usr/bin/env node
// Build reproducible, minimal deployment roots without copying credentials,
// local dependencies, research artifacts, or the parent workspace.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = process.argv[2];
if (!["frontend", "backend", "mcp", "paypal"].includes(service)) throw new Error("Choose frontend, backend, mcp, or paypal");
const stamp = process.env.CHAINPAY_RELEASE_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
if (!/^[a-zA-Z0-9_-]+$/.test(stamp)) throw new Error("Invalid release ID");
const target = path.join(root, ".vercel-staging", stamp, service);
await mkdir(path.dirname(target), { recursive: true });
// Refuse stale handlers or artifacts from a previous upload root.
await mkdir(target);
async function copy(name) {
  await cp(path.join(root, name), path.join(target, name), { recursive: true, filter: source => {
    const parts = path.relative(root, source).split(path.sep);
    return !parts.some(part => ["node_modules", "target", "dist", ".git", ".vercel", ".vercel-staging", ".migration"].includes(part) || (part.startsWith(".env") && part !== ".env.example"));
  } });
}
// The backend crate as a standalone Rust package with exactly one Vercel
// handler. Every other [[bin]] is dropped: its source is not in the upload, and
// Cargo refuses a manifest that names a missing target or default-run.
async function stageRust(handler, features) {
  await copy("backend");
  await copy("Cargo.lock");
  // Pinned MagicBlock Devnet TEE measurements, compiled into the relay with include_str!.
  await mkdir(path.join(target, "shared/cards"), { recursive: true });
  await cp(path.join(root, "shared/cards/tee-measurements.json"), path.join(target, "shared/cards/tee-measurements.json"));
  await cp(path.join(root, "backend/migrations"), path.join(target, "migrations"), { recursive: true });
  const source = await readFile(path.join(root, "backend/Cargo.toml"), "utf8");
  const bins = source.match(/^\[\[bin\]\]\n(?:(?!\[)[^\n]*\n)*/gm) ?? [];
  const kept = bins.find(block => block.includes(`path = "api/${handler}.rs"`));
  if (!kept) throw new Error(`backend/Cargo.toml has no [[bin]] for api/${handler}.rs`);
  let manifest = source.replace(/^default-run = .*\n/m, "");
  for (const block of bins) if (block !== kept) manifest = manifest.replace(block, "");
  manifest = manifest
    .replace('[features]', `[features]\ndefault = ${JSON.stringify(features)}`)
    // The vendored DCAP verifier is copied with backend/ (path dependency).
    .replace('path = "vendor/dcap-qvl"', 'path = "backend/vendor/dcap-qvl"')
    + '\n[lib]\npath = "backend/src/lib.rs"\n\n[workspace]\n\n[profile.release]\noverflow-checks = true\nlto = "fat"\ncodegen-units = 1\n';
  // Vercel discovers Rust handlers under api/ while the library remains intact.
  await mkdir(path.join(target, "api"), { recursive: true });
  await cp(path.join(root, `backend/api/${handler}.rs`), path.join(target, `api/${handler}.rs`));
  await writeFile(path.join(target, "Cargo.toml"), manifest);
}
let config;
if (service === "backend") {
  await stageRust("relay", ["vercel"]);
  // The release guard is a build step, and Vercel then expects static output.
  await mkdir(path.join(target, "public"), { recursive: true });
  await writeFile(path.join(target, "public/robots.txt"), "User-agent: *\nDisallow: /\n");
  // No Vercel cron: card reconciliation (contracts.md §3.4) only runs where the
  // connector is on (Preview), and Vercel crons fire only on Production. The
  // `Cards reconcile` GitHub workflow calls the route instead.
  config = { framework: null, rewrites: [{ source: "/(.*)", destination: "/api/relay" }], functions: { "api/relay.rs": { maxDuration: 300 } } };
} else if (service === "paypal") {
  // One project, one origin: the PayPal Rust function under /v1/paypal and the
  // PayPal workspace (frontend/paypal.html) as the static site. Separate from
  // the Colosseum relay, its Convex storage and its release group.
  await stageRust("paypal", ["vercel", "paypal"]);
  for (const name of ["package.json", "package-lock.json", "sdk", "mcp-server", "demo-merchant", "app", "frontend", "shared"]) await copy(name);
  await mkdir(path.join(target, "public"), { recursive: true });
  const api = { destination: "/api/paypal" };
  const web = { destination: "/paypal.html" };
  config = {
    framework: null,
    installCommand: "npm ci --include=dev --ignore-scripts && npm --prefix frontend ci --include=dev --ignore-scripts",
    // Vite reads VITE_CHAINPAY_PAYPAL and VITE_CHAINPAY_PAYPAL_API_ORIGIN here, at build time.
    buildCommand: "npm --prefix sdk run build && npm --prefix frontend run build:paypal && cp -R frontend/dist-paypal/. public/ && printf 'User-agent: *\\nDisallow: /\\n' > public/robots.txt",
    outputDirectory: "public",
    functions: { "api/paypal.rs": { maxDuration: 300 } },
    rewrites: [
      { source: "/v1/paypal/:path*", ...api },
      { source: "/internal/cron/paypal/:path*", ...api },
      { source: "/healthz", ...api },
      { source: "/paypal", ...web },
      { source: "/paypal/:path*", ...web },
      { source: "/", ...web },
    ],
    headers: [{ source: "/(.*)", headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }],
  };
} else {
  for (const name of ["package.json", "package-lock.json", "sdk", "mcp-server", "demo-merchant", "app"]) await copy(name);
  if (service === "frontend") {
    await copy("frontend");
    await copy("shared");
    config = { framework: "vite", installCommand: "npm ci --include=dev --ignore-scripts && npm --prefix frontend ci --include=dev --ignore-scripts", buildCommand: "npm --prefix sdk run build && npm --prefix frontend run build", outputDirectory: "frontend/dist", rewrites: [{ source: "/((?!.*\\.[^/]+$).*)", destination: "/index.html" }] };
  } else {
    await mkdir(path.join(target, "api"), { recursive: true });
    await mkdir(path.join(target, "public"), { recursive: true });
    await writeFile(path.join(target, "public/robots.txt"), "User-agent: *\nDisallow: /\n");
    // Use the already typechecked ESM output. Vercel's default root TS settings
    // otherwise turn this bridge into require() of an ESM package at runtime.
    const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    pkg.type = "module";
    await writeFile(path.join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    await writeFile(path.join(target, "api/mcp.js"), 'export { default } from "../mcp-server/dist/vercel.js";\n');
    config = { framework: null, installCommand: "npm ci --include=dev --ignore-scripts", buildCommand: "npm --prefix sdk run build && npm --prefix mcp-server run build", functions: { "api/mcp.js": { maxDuration: 300, includeFiles: "mcp-server/assets/**" } }, rewrites: [{ source: "/(.*)", destination: "/api/mcp" }] };
  }
}
// Fail the hosted build before it silently pairs the wrong database or origins.
await mkdir(path.join(target, "scripts"), { recursive: true });
await cp(path.join(root, "scripts/check-release-env.mjs"), path.join(target, "scripts/check-release-env.mjs"));
await cp(path.join(root, "scripts/production-release.json"), path.join(target, "scripts/production-release.json"));
// The Colosseum guard checks the Convex release group, which PayPal does not use.
// The PayPal function validates its own configuration at startup and refuses
// anything but the sandbox and a chainpay_paypal_* database.
if (service !== "paypal") {
  const guard = `node scripts/check-release-env.mjs ${service}`;
  config.buildCommand = config.buildCommand ? `${guard} && ${config.buildCommand}` : guard;
}
await writeFile(path.join(target, "vercel.json"), JSON.stringify(config, null, 2) + "\n");
console.log(target);
