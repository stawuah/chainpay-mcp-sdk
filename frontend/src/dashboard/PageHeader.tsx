import type { ReactNode } from "react";
import type { TabCopy } from "./tabCopy";

/*
  One page header for every tab. Replaces the inline .dashboard-heading block
  whose kicker, title and subtitle were a nested ternary chain.

  The action sits in its own row rather than floating beside the subtitle, which
  is what caused the Refresh button to collide with the subtitle text on the
  tabs whose subtitle wraps to two lines.
*/
export function PageHeader({ copy, action }: { copy: TabCopy; action?: ReactNode }) {
  return (
    <div className="dashboard-heading">
      <div className="dashboard-heading-text">
        <h1 className="t-xl">{copy.title}</h1>
        <p>{copy.subtitle}</p>
      </div>
      {action ? <div className="dashboard-heading-action">{action}</div> : null}
    </div>
  );
}
