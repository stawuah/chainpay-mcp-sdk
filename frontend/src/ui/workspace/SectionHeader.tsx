import type { ReactNode } from "react";

/*
  The one header every workspace section uses: a title, an optional one-line
  description, and at most one action on the same row (it wraps under the
  title on narrow screens). Replaces the per-panel .dashboard-card-heading
  variants and the floating .owner-page-actions rows.
*/
export type SectionHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Heading level. Sections inside a page are h2; nested groups h3. */
  level?: 2 | 3;
  id?: string;
  className?: string;
};

export function SectionHeader({ title, description, action, level = 2, id, className }: SectionHeaderProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={`cp-section-header${className ? ` ${className}` : ""}`}>
      <div className="cp-section-header-text">
        <Heading id={id}>{title}</Heading>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="cp-section-header-action">{action}</div> : null}
    </div>
  );
}
