import { STATUS_LABEL, findUseCase, imageFor, type UseCase } from "../use-cases/data";

// "What will your agent pay for?" Four use cases between the story and the
// agent cards band. Static: no reveal, no carousel. Titles come from the
// use-case data so the landing and /use-cases never disagree.
// Ruling: _bmad-output/design-council/landing-brand-ruling-2026-10-04.md (B1 to B4, B11).
const SLUGS = ["pay-per-api-call", "one-tap-stop", "receipts-for-accounting", "paypal-invoices"] as const;

export function UseCaseStrip() {
  const items = SLUGS.map(findUseCase).filter((item): item is UseCase => Boolean(item));
  return (
    <section className="landing-uses page-width" id="what-agents-pay-for" aria-labelledby="landing-uses-heading">
      <div className="landing-uses-head">
        <div>
          <p className="section-kicker">USE CASES</p>
          <h2 data-pet-perch id="landing-uses-heading" className="t-xl">What will your agent pay for?</h2>
        </div>
        <a className="landing-uses-all" href="/use-cases">See all use cases</a>
      </div>
      <ul className="landing-uses-grid">
        {items.map((item) => (
          <li key={item.slug}>
            <a className="landing-use" href={`/use-cases/${item.slug}`}>
              <span className="landing-use-media">
                <img src={imageFor(item, "card")} srcSet={`${imageFor(item, "card")} 800w, ${imageFor(item, "hero")} 1600w`} sizes="(max-width: 639px) 112px, (max-width: 1079px) 46vw, 300px" alt="" width={800} height={600} loading="lazy" decoding="async" />
              </span>
              <span className="landing-use-body">
                <span className="landing-use-title">{item.title}</span>
                {item.status === "soon" ? <span className="landing-next-status">{STATUS_LABEL.soon}</span> : null}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <a className="landing-uses-all landing-uses-all-below" href="/use-cases">See all use cases</a>
    </section>
  );
}
