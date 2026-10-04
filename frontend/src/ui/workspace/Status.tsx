import { Ban, CalendarX, CircleCheck, CircleHelp, CircleX, Clock3, Pause, TriangleAlert, type LucideIcon } from "lucide-react";

/*
  One status vocabulary for the owner workspace (DESIGN.md, 2026-10-04).

  Every status renders an icon, a text label and a restrained tone. Each meaning
  has its own icon, so nothing is told apart by colour alone and no two
  different states share a checkmark. Domains keep their own words ("Waiting for
  approval", "Settled"); only the appearance is shared.
*/
export type StatusTone = "positive" | "info" | "neutral" | "warning" | "critical" | "unknown";
export type StatusIcon = "check-circle" | "clock" | "pause" | "alert-triangle" | "calendar-x" | "x-circle" | "ban" | "help-circle";

const ICONS: Record<StatusIcon, LucideIcon> = {
  "check-circle": CircleCheck,
  clock: Clock3,
  pause: Pause,
  "alert-triangle": TriangleAlert,
  "calendar-x": CalendarX,
  "x-circle": CircleX,
  ban: Ban,
  "help-circle": CircleHelp,
};

export type StatusProps = {
  tone: StatusTone;
  icon: StatusIcon;
  label: string;
  /** Extra words for assistive technology, e.g. what the state means. */
  description?: string;
  className?: string;
};

export function Status({ tone, icon, label, description, className }: StatusProps) {
  const Icon = ICONS[icon];
  return (
    <span className={`cp-status${className ? ` ${className}` : ""}`} data-tone={tone} data-icon={icon} title={description}>
      <Icon aria-hidden="true" size={14} strokeWidth={2} />
      <span>{label}</span>
      {description ? <span className="sr-only">. {description}</span> : null}
    </span>
  );
}

/** The meaning table from DESIGN.md, so callers pick a meaning, not a colour. */
export const STATUS_MEANINGS = {
  active: { tone: "positive", icon: "check-circle" },
  settled: { tone: "positive", icon: "check-circle" },
  verified: { tone: "positive", icon: "check-circle" },
  pending: { tone: "info", icon: "clock" },
  paused: { tone: "neutral", icon: "pause" },
  review: { tone: "warning", icon: "alert-triangle" },
  expired: { tone: "neutral", icon: "calendar-x" },
  revoked: { tone: "critical", icon: "ban" },
  failed: { tone: "critical", icon: "x-circle" },
  unknown: { tone: "unknown", icon: "help-circle" },
} as const satisfies Record<string, { tone: StatusTone; icon: StatusIcon }>;

export type StatusMeaning = keyof typeof STATUS_MEANINGS;

export function statusFor(meaning: StatusMeaning, label: string, description?: string): StatusProps {
  return { ...STATUS_MEANINGS[meaning], label, description };
}

/** Spending permission status, in the permission's own words. */
export function mandateStatusProps(status: string, options: { expiringSoon?: boolean } = {}): StatusProps {
  switch (status) {
    case "active":
      return options.expiringSoon
        ? statusFor("review", "Expires soon", "Active, and expires within about a day (estimated).")
        : statusFor("active", "Active");
    case "paused":
      return statusFor("paused", "Paused");
    case "expired":
      return statusFor("expired", "Expired");
    case "revoked":
      return statusFor("revoked", "Revoked");
    default:
      return statusFor("unknown", "Unknown");
  }
}
