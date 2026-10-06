import { Check } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { PublicNotFoundPage } from "../routing/NotFoundPages";
import { AUDIENCES, STATUS_LABEL, USE_CASES, findUseCase, imageFor } from "./data";
import { UseCaseCard } from "./UseCaseCard";
import { UseCaseChrome, useInternalLink } from "./UseCaseChrome";

const AUDIENCE_LABEL = Object.fromEntries(AUDIENCES.map((a) => [a.id, a.label]));

export default function UseCaseDetail({ slug }: { slug: string }) {
  const onLink = useInternalLink();
  const item = findUseCase(slug);
  if (!item) return <PublicNotFoundPage path={`/use-cases/${slug}`} />;

  const related = USE_CASES.filter((other) => other.audience === item.audience && other.slug !== item.slug).slice(0, 3);
  const external = item.cta.href.startsWith("http");

  return (
    <UseCaseChrome title={`${item.title} · ChainPay`}>
      <div className="page-width">
        <a className="uc-back" href="/use-cases" onClick={onLink}>← All use cases</a>
      </div>

      <section className="uc-detail-hero page-width" aria-labelledby="uc-detail-heading">
        <div className="uc-detail-copy">
          <p className="uc-card-meta">
            <span className="uc-audience">{AUDIENCE_LABEL[item.audience]}</span>
            <span className={`uc-status uc-status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
          </p>
          <h1 id="uc-detail-heading" className="t-xl">{item.title}</h1>
          <p className="t-body uc-detail-summary">{item.summary}</p>
        </div>
        <div className="uc-detail-media">
          <img src={imageFor(item, "hero")} alt={item.imageAlt} width={1600} height={1200} />
        </div>
      </section>

      <section className="page-width uc-section" aria-labelledby="uc-how">
        <h2 id="uc-how" className="t-lg">How it works</h2>
        <ol className="uc-steps">
          {item.steps.map((step, index) => (
            <li key={step} className="uc-step">
              <span className="uc-step-number" aria-hidden="true">{index + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="page-width uc-section uc-split">
        <div>
          <h2 id="uc-why" className="t-lg">Why it matters</h2>
          <ul className="uc-why" aria-labelledby="uc-why">
            {item.why.map((line) => (
              <li key={line}><Check aria-hidden="true" size={18} strokeWidth={2.5} /> <span>{line}</span></li>
            ))}
          </ul>
        </div>
        <figure className="uc-example">
          <figcaption>Example</figcaption>
          <dl>
            {item.example.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </figure>
      </section>

      <section className="page-width uc-section">
        <div className="uc-cta">
          <div>
            <h2 className="t-lg">{item.status === "soon" ? item.soonNote?.title ?? "Not switched on yet." : item.liveNote?.title ?? "Try it on devnet."}</h2>
            <p>{item.status === "soon" ? item.soonNote?.body ?? "It's built and waiting. Meanwhile, set up the limits it will use." : item.liveNote?.body ?? "Test tokens, real rules. Connecting a wallet doesn't let anything spend."}</p>
          </div>
          {external
            ? <Button variant="secondary" size="lg" label={item.cta.label} isDisabled={false} href={item.cta.href} target="_blank" rel="noreferrer" />
            : <Button variant="secondary" size="lg" label={item.cta.label} isDisabled={false} href={item.cta.href} />}
        </div>
      </section>

      {related.length > 0 ? (
        <section className="page-width uc-section" aria-labelledby="uc-more">
          <h2 id="uc-more" className="t-lg">More like this</h2>
          <div className="uc-grid">
            {related.map((other) => <UseCaseCard key={other.slug} item={other} />)}
          </div>
        </section>
      ) : null}
    </UseCaseChrome>
  );
}
