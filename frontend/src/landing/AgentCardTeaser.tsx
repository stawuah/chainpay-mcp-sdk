import { Button } from "@astryxdesign/core/Button";
import { STATUS_LABEL, findUseCase, imageFor } from "../use-cases/data";

// "Coming next" band. Ruling: _bmad-output/design-council/agent-cards-landing-ruling-2026-10-03.md (C1–C8).
// Copy comes from the use case so the landing and /use-cases never disagree.
export function AgentCardTeaser() {
  const item = findUseCase("private-agent-card");
  if (!item) return null;
  return (
    <section className="landing-next page-width" aria-labelledby="landing-next-heading">
      <div className="landing-next-card">
        <div className="landing-next-copy">
          <p className="landing-next-meta">
            <span className="section-kicker">Coming next</span>
            <span className="landing-next-status">{STATUS_LABEL[item.status]}</span>
          </p>
          <h2 data-pet-perch id="landing-next-heading">{item.title}.</h2>
          <p className="landing-next-body">{item.summary}</p>
          <Button variant="secondary" size="lg" label="See how it will work" isDisabled={false} href={`/use-cases/${item.slug}`} />
        </div>
        <div className="landing-next-media">
          <img src={imageFor(item, "card")} srcSet={`${imageFor(item, "card")} 800w, ${imageFor(item, "hero")} 1600w`} sizes="(max-width: 760px) 100vw, 560px" alt={item.imageAlt} width={800} height={600} loading="lazy" decoding="async" />
        </div>
      </div>
    </section>
  );
}
