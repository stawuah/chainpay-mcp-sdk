import { it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { runMigrationIntegration } from "../scripts/migrate-storage.integration.test.mjs";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
it("round-trips the real CLI through PostgreSQL and the Convex HTTP contract, resumes import, and rolls back failed restores", async () => {
  vi.stubEnv("CHAINPAY_MAINTENANCE", "true");
  vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_ENABLED", "true");
  vi.stubEnv("CHAINPAY_CONVEX_MIGRATION_SECRET", "integration-only-".repeat(3));
  const t = convexTest(schema, modules);
  try { await runMigrationIntegration((path: string, init: RequestInit) => t.fetch(path, init)); }
  finally { vi.unstubAllEnvs(); }
}, 120_000);
