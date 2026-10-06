import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function latestRun({ repository, sha, runs }) {
  return runs.filter(run => run.head_sha === sha && run.head_branch === "master" && run.event === "push" && run.head_repository?.full_name === repository)
    .sort((a, b) => b.id - a.id)[0];
}

// The workflow_run event can arrive before the runs API shows the triggering
// run as completed. Only that lag is worth waiting out; a failed run is final.
export function revisionPending({ repository, sha, runs }) {
  const latest = latestRun({ repository, sha, runs });
  return !latest || latest.status !== "completed";
}

export function assertDeployRevision({ repository, sha, tip, runs }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || sha !== tip) throw new Error("Deployment revision must be the current master tip");
  const latest = latestRun({ repository, sha, runs });
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") throw new Error("The latest Release checks push run for this exact master revision must succeed before deployment");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid repository");
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Invalid revision");
  const api = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
  const tip = api(`repos/${repository}/commits/master`).sha;
  const listRuns = () => api(`repos/${repository}/actions/workflows/release-checks.yml/runs?head_sha=${sha}&event=push&per_page=100`).workflow_runs;
  let runs = listRuns();
  for (let attempt = 1; attempt <= 12 && revisionPending({ repository, sha, runs }); attempt++) {
    console.log(`Release checks for ${sha} not shown as completed yet; checking again in 5s (${attempt}/12)`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    runs = listRuns();
  }
  assertDeployRevision({ repository, sha, tip, runs });
  console.log(`Release checks passed for current master ${sha}`);
}
