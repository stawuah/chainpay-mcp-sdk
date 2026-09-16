import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Arrow } from "../ui/marks";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { shortAddress } from "../ui/marks";
import { publicReceiptPath } from "../receipts/model";
import { hasReadySession } from "../session";
import { fetchX402Jobs, x402CycleSteps, x402JobResumable, x402StatusLabel, type X402Job } from "./x402Jobs";
import type { McpToolResponse } from "../owner/runtime";
import { toolText } from "../owner/runtime";

type X402JobsPanelProps = {
  mandate?: string;
  sessionReady?: boolean;
  onSignIn?: () => void;
  onCallMcp?: (name: string, args: Record<string, unknown>) => Promise<McpToolResponse>;
};

export function X402JobsPanel({ mandate, sessionReady = hasReadySession(), onSignIn, onCallMcp }: X402JobsPanelProps) {
  const [jobs, setJobs] = useState<X402Job[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [resumeJobId, setResumeJobId] = useState<string | null>(null);
  const [resumeMessage, setResumeMessage] = useState("");

  useEffect(() => {
    if (!sessionReady) {
      setJobs([]);
      setStatus("idle");
      setError("");
      return undefined;
    }
    let active = true;
    setStatus("loading");
    setError("");
    void fetchX402Jobs(mandate)
      .then((next) => {
        if (!active) return;
        setJobs(next);
        setStatus("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setJobs([]);
        setStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [mandate, sessionReady]);

  return (
    <div className="dashboard-card x402-jobs-card">
      <div className="dashboard-card-heading">
        <div>
          <span className="section-kicker">HTTP 402 JOBS</span>
          <h2>Agent spend on pay.sh and x402</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          label="Refresh"
          isDisabled={status === "loading"}
          onClick={() => {
            setStatus("loading");
            void fetchX402Jobs(mandate)
              .then((next) => { setJobs(next); setStatus("ready"); setError(""); })
              .catch((cause) => {
                setJobs([]);
                setStatus("error");
                setError(cause instanceof Error ? cause.message : String(cause));
              });
          }}
        />
      </div>
      <p className="builder-intro">
        One row is one HTTP 402 attempt: resource, challenge, mandate, status. ChainPay settles custom x402/1.0 only.
        Standard x402 v2, MPP, MCPay, and Coinbase Bazaar show here as seen, not payable, until a later rail lands.
      </p>
      {!sessionReady && (
        <div className="page-empty compact-empty">
          <p>Sign in to load HTTP 402 jobs for this wallet.</p>
          {onSignIn && <Button type="button" variant="secondary" label="Sign in" isDisabled={false} onClick={onSignIn} />}
        </div>
      )}
      {sessionReady && status === "loading" && <Skeleton className="x402-jobs-skeleton" />}
      {status === "error" && <p className="builder-error" role="alert"><b>Could not load jobs</b><span>{error}</span></p>}
      {status === "ready" && jobs.length === 0 && (
        <div className="page-empty compact-empty">
          <p>No HTTP 402 jobs yet. When an agent hits a paid API through ChainPay MCP, the cycle shows up here.</p>
        </div>
      )}
      {resumeMessage && <p className="builder-intro" role="status">{resumeMessage}</p>}
      {status === "ready" && jobs.length > 0 && (
        <div className="x402-jobs-list">
          {jobs.map((job) => (
            <article className="x402-job-row" key={job.x402_payment_id}>
              <div className="x402-job-heading">
                <div>
                  <span className="chip chip-blue">{job.protocol.replaceAll("_", " ")}</span>
                  <h3>{job.resource}</h3>
                </div>
                <span className={`state-pill ${job.status === "failed" ? "failed" : job.status === "verified" ? "ok" : ""}`}>
                  <i /> {x402StatusLabel(job.status)}
                </span>
              </div>
              <div className="x402-job-meta">
                <span><b>x402 job ID</b><code>{job.x402_payment_id}</code></span>
                {job.amount && <span><b>Amount</b><code>{job.amount}</code></span>}
                {job.mandate && <span><b>Mandate PDA</b><code>{shortAddress(job.mandate)}</code></span>}
                {!job.payable && (
                  <span className="x402-blocked-note">
                    <b>Rail</b>
                    Seen, not payable · {job.error ?? "x402_unsupported_sponsor"}
                  </span>
                )}
              </div>
              <div className="x402-cycle-rail">
                {x402CycleSteps(job).map((step, index) => (
                  <span className="x402-cycle-step" key={`${job.x402_payment_id}-${index}`}>{step}</span>
                ))}
              </div>
              {job.receipt_address && (
                <a className="x402-receipt-link" href={publicReceiptPath(job.receipt_address)}>
                  View receipt · {shortAddress(job.receipt_address)} <Arrow />
                </a>
              )}
              {x402JobResumable(job) && onCallMcp && (
                <Button
                  type="button"
                  variant="secondary"
                  label={resumeJobId === job.x402_payment_id ? "Resuming…" : "Resume"}
                  isDisabled={resumeJobId !== null}
                  onClick={() => {
                    if (!job.payment_id) return;
                    setResumeMessage("");
                    setResumeJobId(job.x402_payment_id);
                    void onCallMcp("execute_x402_payment", { paymentId: job.payment_id })
                      .then((response) => {
                        setResumeMessage(toolText(response));
                        return fetchX402Jobs(mandate);
                      })
                      .then((next) => { setJobs(next); setStatus("ready"); })
                      .catch((cause) => setResumeMessage(cause instanceof Error ? cause.message : String(cause)))
                      .finally(() => setResumeJobId(null));
                  }}
                />
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
