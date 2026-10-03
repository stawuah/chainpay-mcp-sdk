#!/usr/bin/env node
// Build reproducible, minimal deployment roots without copying credentials,
// local dependencies, research artifacts, or the parent workspace.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = process.argv[2];
if (!["frontend", "backend", "mcp"].includes(service)) throw new Error("Choose frontend, backend, or mcp");
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
let config;
if (service === "backend") {
  await copy("backend");
  await copy("Cargo.lock");
  await cp(path.join(root, "backend/migrations"), path.join(target, "migrations"), { recursive: true });
  // Backend is independently deployable; stage it as a standalone Rust package.
  const manifest = (await readFile(path.join(root, "backend/Cargo.toml"), "utf8"))
    .replace('path = "api/relay.rs"', 'path = "backend/api/relay.rs"')
    .replace('[features]', '[features]\ndefault = ["vercel"]')
    + '\n[lib]\npath = "backend/src/lib.rs"\n\n[workspace]\n\n[profile.release]\noverflow-checks = true\nlto = "fat"\ncodegen-units = 1\n';
  // Vercel discovers Rust handlers under api/ while the library remains intact.
  await mkdir(path.join(target, "api"), { recursive: true });
  await cp(path.join(root, "backend/api/relay.rs"), path.join(target, "api/relay.rs"));
  await writeFile(path.join(target, "Cargo.toml"), manifest.replace('path = "backend/api/relay.rs"', 'path = "api/relay.rs"'));
  // The release guard is a build step, and Vercel then expects static output.
  await mkdir(path.join(target, "public"), { recursive: true });
  await writeFile(path.join(target, "public/robots.txt"), "User-agent: *\nDisallow: /\n");
  // Card reconciliation (contracts.md §3.4). Answers 404 unless CARDS_CONNECTOR_ENABLED=true.
  config = { framework: null, rewrites: [{ source: "/(.*)", destination: "/api/relay" }], functions: { "api/relay.rs": { maxDuration: 300 } }, crons: [{ path: "/internal/cron/cards/reconcile", schedule: "*/5 * * * *" }] };
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
const guard = `node scripts/check-release-env.mjs ${service}`;
config.buildCommand = config.buildCommand ? `${guard} && ${config.buildCommand}` : guard;
await writeFile(path.join(target, "vercel.json"), JSON.stringify(config, null, 2) + "\n");
console.log(target);
