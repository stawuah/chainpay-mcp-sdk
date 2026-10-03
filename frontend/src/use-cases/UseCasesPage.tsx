import { useState } from "react";
import { AUDIENCES, USE_CASES, type Audience } from "./data";
import { UseCaseCard } from "./UseCaseCard";
import { UseCaseChrome } from "./UseCaseChrome";

type Filter = Audience | "all";

export default function UseCasesPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = filter === "all" ? USE_CASES : USE_CASES.filter((item) => item.audience === filter);
  const options: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: USE_CASES.length },
    ...AUDIENCES.map((a) => ({ ...a, count: USE_CASES.filter((item) => item.audience === a.id).length })),
  ];

  return (
    <UseCaseChrome title="Use cases · ChainPay">
      <section className="uc-hero page-width" aria-labelledby="uc-heading">
        <p className="landing-eyebrow">Use cases</p>
        <h1 id="uc-heading" className="t-mega">What will your agent pay for?</h1>
        <p className="t-body uc-hero-text">Real ways people put agents on a budget. Pick one that sounds like you.</p>
      </section>

      <section className="page-width uc-browse" aria-label="Use cases">
        <div className="uc-filters" role="group" aria-label="Filter by who it's for">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="uc-pill"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label} <span className="uc-pill-count">{option.count}</span>
            </button>
          ))}
        </div>

        <div className="uc-grid">
          {visible.map((item, index) => (
            <UseCaseCard key={item.slug} item={item} featured={filter === "all" && Boolean(item.featured)} eager={index < 3} />
          ))}
        </div>

        <p className="t-body-sm uc-footnote">ChainPay runs on Solana devnet. Amounts on these pages are examples.</p>
      </section>
    </UseCaseChrome>
  );
}
