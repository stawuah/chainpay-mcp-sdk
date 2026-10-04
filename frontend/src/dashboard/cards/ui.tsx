import {
  AlarmClock, CircleCheck, Info, CircleDot, CircleHelp, CircleX, Clock3, Contrast, Dot, Flag, Hourglass, Lock, RotateCcw, Snowflake, TriangleAlert, Undo2, Wrench,
} from "lucide-react";
import { formatUsdCents } from "@chainpay/sdk";
import type { PillIcon, StatePill } from "./lifecycle";

const ICONS: Record<PillIcon, typeof Clock3> = {
  clock: Clock3, hold: CircleDot, check: CircleCheck, half: Contrast, undo: Undo2, hourglass: Hourglass, late: AlarmClock,
  refund: RotateCcw, flag: Flag, alert: TriangleAlert, x: CircleX, help: CircleHelp, snow: Snowflake, lock: Lock, wrench: Wrench, dot: Dot,
};

/** Icon + word, never color alone (ruling K8). */
export function Pill({ pill, withDetail = false }: { pill: StatePill; withDetail?: boolean }) {
  const Icon = ICONS[pill.icon];
  return (
    <span className="cp-card-pill" data-tone={pill.tone} data-state={pill.key} title={withDetail ? undefined : pill.detail}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span>{pill.label}</span>
    </span>
  );
}

export function Money({ cents, className }: { cents: string | bigint; className?: string }) {
  return <span className={`cp-money${className ? ` ${className}` : ""}`}>{formatUsdCents(cents)}</span>;
}

/**
 * Shown wherever a value lives in the private rules and the owner hasn't opened them. Never rendered as $0.
 * `failed`: the owner opened them but the read failed, which must not look like "Private".
 */
export function PrivateValue({ failed = false }: { failed?: boolean }) {
  if (failed) return <span className="cp-private-value is-failed" data-read="failed"><CircleHelp size={12} aria-hidden="true" /> Couldn't load</span>;
  return <span className="cp-private-value"><Lock size={12} aria-hidden="true" /> Private</span>;
}

/** A private read that failed (thrown, or an RPC error from the rollup), as opposed to one this wallet can't see. */
export function readFailed(read: { policy: { state: string }; period: { state: string } } | undefined): boolean {
  return read?.policy.state === "rpc_error" || read?.period.state === "rpc_error";
}

export function IllustrativeBanner() {
  return (
    <div className="cp-cards-illustrative" data-testid="cards-illustrative" role="note">
      <Info size={18} aria-hidden="true" />
      <p><b>Illustrative data.</b> Cards aren't live yet, so this shows example cards. Nothing here is real money or a real card.</p>
    </div>
  );
}

export function formatWhen(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function formatDay(iso: string | undefined | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function shortKey(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}
