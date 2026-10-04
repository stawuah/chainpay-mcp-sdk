import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { BrandLogo } from "../brand/Brand";
import { STATUS_API_URL } from "../config/public";
import {
  STATUS_COMPONENTS, dayLevel, overallState, recentDays, uptimeRatio,
  type CheckState, type DayCounts, type Overall,
} from "../../../shared/status";
import "./status.css";

type Summary = {
  generatedAt: number;
  components: { id: string; state: CheckState | null; at: number | null; latencyMs: number | null; days: (DayCounts & { day: string })[] }[];
  incidents: { id: string; title: string; impact: "minor" | "major"; components: string[]; startedAt: number; resolvedAt: number | null; updates: { at: number; state: string; message: string }[] }[];
};

type Bar = "ok" | "issues" | "outage" | "none";

const REFRESH_MS = 60_000;
const PHONE = "(max-width: 640px)";

// Phones show 30 days so each bar stays wide enough to tap.
function useDayCount() {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia?.(PHONE).matches === true);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return;
    const sync = () => setPhone(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return phone ? 30 : 90;
}

const OVERALL: Record<Overall, { label: string; tone: Bar }> = {
  operational: { label: "All systems operational", tone: "ok" },
  degraded: { label: "Some systems are slow", tone: "issues" },
  partial: { label: "Partial outage", tone: "issues" },
  major: { label: "Major outage", tone: "outage" },
  unknown: { label: "Status unknown", tone: "none" },
};

const CURRENT: Record<CheckState, { label: string; tone: Bar }> = {
  up: { label: "Operational", tone: "ok" },
  degraded: { label: "Slow", tone: "issues" },
  down: { label: "Down", tone: "outage" },
};

const BAR_LABEL: Record<Bar, string> = { ok: "No issues", issues: "Some issues", outage: "Outage", none: "No data" };

function toBar(day: DayCounts | undefined): Bar {
  const level = dayLevel(day);
  if (level === "operational") return "ok";
  if (level === "major") return "outage";
  if (level === "none") return "none";
  return "issues";
}

function StateIcon({ tone, size = 18 }: { tone: Bar; size?: number }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "issues" ? AlertTriangle : tone === "outage" ? XCircle : CircleHelp;
  return <Icon aria-hidden="true" size={size} strokeWidth={2.25} className={`status-icon status-tone-${tone}`} />;
}

function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

const dateLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const timeLabel = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const percent = (ratio: number | null) => ratio === null ? "No data yet" : `${(Math.floor(ratio * 10_000) / 100).toFixed(2)}% uptime`;

function UptimeBars({ name, days, keys }: { name: string; days: Map<string, DayCounts>; keys: string[] }) {
  const [active, setActive] = useState<number | null>(null);
  const problems = keys.filter((key) => { const bar = toBar(days.get(key)); return bar === "issues" || bar === "outage"; });
  const summary = problems.length === 0
    ? `${name}: no issues recorded in the last ${keys.length} days.`
    : `${name}: issues on ${problems.map(dateLabel).join(", ")}.`;
  const activeKey = active === null ? null : keys[active];
  const activeDay = activeKey ? days.get(activeKey) : undefined;

  return (
    <div className="status-bars-wrap">
      <div className="status-bars" role="img" aria-label={summary} onPointerLeave={() => setActive(null)}>
        {keys.map((key, index) => {
          const bar = toBar(days.get(key));
          return (
            <span
              key={key}
              className={`status-bar status-bar-${bar}${active === index ? " is-active" : ""}`}
              onPointerEnter={() => setActive(index)}
              onPointerDown={() => setActive(index)}
            />
          );
        })}
      </div>
      {activeKey ? (
        <div className="status-tooltip" style={{ left: `${((active! + 0.5) / keys.length) * 100}%` }} aria-hidden="true">
          <strong>{dateLabel(activeKey)}</strong>
          <span><StateIcon tone={toBar(activeDay)} size={14} /> {BAR_LABEL[toBar(activeDay)]}</span>
          {activeDay ? <span className="status-tooltip-meta">{percent(uptimeRatio([activeDay]))} · {activeDay.total} checks</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function StatusPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dayCount = useDayCount();

  useEffect(() => {
    document.title = "Status · ChainPay";
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${STATUS_API_URL}/status/v1`, { credentials: "omit", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as Summary;
        if (!cancelled) { setData(body); setFailed(false); }
      } catch {
        if (!cancelled) setFailed(true);
      }
      if (!cancelled) setNow(Date.now());
    };
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const keys = recentDays(now, dayCount);
  const byId = new Map(data?.components.map((c) => [c.id, c]) ?? []);
  const overall = data ? overallState(STATUS_COMPONENTS.map((c) => byId.get(c.id) ?? { state: null, at: null }), now) : "unknown";
  const lastCheck = data ? Math.max(0, ...data.components.map((c) => c.at ?? 0)) : 0;
  const open = data?.incidents.filter((i) => i.resolvedAt === null) ?? [];
  const past = data?.incidents.filter((i) => i.resolvedAt !== null) ?? [];
  const headline = failed && !data ? { label: "Status data unavailable", tone: "none" as Bar } : OVERALL[overall];

  return (
    <div className="site-shell cp-app status-page">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home"><BrandLogo /></a>
        <a className="login-link status-back" href="/">Back to ChainPay</a>
      </header>

      <main className="page-width status-main" aria-busy={!data && !failed}>
        <div className="status-title-row">
          <h1 className="t-xl">System status</h1>
          <span className="status-devnet">Solana devnet</span>
        </div>

        <section className={`status-banner status-banner-${headline.tone}`} aria-live="polite">
          <StateIcon tone={headline.tone} size={28} />
          <div>
            <h2>{data || failed ? headline.label : "Checking…"}</h2>
            <p>
              {failed && !data
                ? "We couldn't load status right now. This page retries every minute."
                : lastCheck ? `Checked every 5 minutes · last check ${ago(lastCheck, now)}` : "Checked every 5 minutes"}
            </p>
          </div>
        </section>

        {open.map((incident) => (
          <section key={incident.id} className={`status-incident status-incident-${incident.impact}`} aria-label="Active incident">
            <h2><StateIcon tone={incident.impact === "major" ? "outage" : "issues"} /> {incident.title}</h2>
            <ol>
              {[...incident.updates].reverse().map((update) => (
                <li key={update.at}><strong>{update.state}</strong> · {timeLabel(update.at)}<p>{update.message}</p></li>
              ))}
            </ol>
          </section>
        ))}

        <section className="status-card" aria-labelledby="status-components">
          <div className="status-card-head">
            <h2 id="status-components">Components</h2>
            <div className="status-legend" aria-hidden="true">
              {(["ok", "issues", "outage", "none"] as Bar[]).map((bar) => (
                <span key={bar}><i className={`status-bar status-bar-${bar}`} /> {BAR_LABEL[bar]}</span>
              ))}
            </div>
          </div>
          {STATUS_COMPONENTS.map((component) => {
            const row = byId.get(component.id);
            const days = new Map((row?.days ?? []).map((d) => [d.day, d]));
            const current = row?.state ? CURRENT[row.state] : { label: data ? "No data yet" : failed ? "Unknown" : "Checking…", tone: "none" as Bar };
            return (
              <article key={component.id} className="status-row">
                <div className="status-row-head">
                  <div>
                    <h3>{component.name}</h3>
                    <p>{component.description}</p>
                  </div>
                  <span className={`status-current status-tone-${current.tone}`}><StateIcon tone={current.tone} /> {current.label}</span>
                </div>
                <UptimeBars name={component.name} days={days} keys={keys} />
                <div className="status-axis">
                  <span>{dayCount} days ago</span>
                  <span>{percent(uptimeRatio(keys.flatMap((key) => days.get(key) ?? [])))}</span>
                  <span>Today</span>
                </div>
              </article>
            );
          })}
        </section>

        <section className="status-card" aria-labelledby="status-history">
          <h2 id="status-history">Past incidents</h2>
          {past.length === 0 ? <p className="status-empty">No incidents in the last 14 days.</p> : (
            <ul className="status-past">
              {past.map((incident) => (
                <li key={incident.id}>
                  <strong>{incident.title}</strong>
                  <span>{timeLabel(incident.startedAt)} – resolved {timeLabel(incident.resolvedAt!)}</span>
                  <p>{incident.updates.at(-1)?.message}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="t-body-sm status-foot">Times in UTC. ChainPay runs on Solana devnet; this page reports on test infrastructure.</p>
      </main>
    </div>
  );
}
