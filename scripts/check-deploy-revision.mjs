import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function assertDeployRevision({ repository, sha, tip, runs }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || sha !== tip) throw new Error("Deployment revision must be the current master tip");
  const latest = runs.filter(run => run.head_sha === sha && run.head_branch === "master" && run.event === "push" && run.head_repository?.full_name === repository)
    .sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") throw new Error("The latest Release checks push run for this exact master revision must succeed before deployment");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid repository");
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Invalid revision");
  const api = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
  const tip = api(`repos/${repository}/commits/master`).sha;
  const runs = api(`repos/${repository}/actions/workflows/release-checks.yml/runs?head_sha=${sha}&event=push&per_page=100`).workflow_runs;
  assertDeployRevision({ repository, sha, tip, runs });
  console.log(`Release checks passed for current master ${sha}`);
}
