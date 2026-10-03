import { AUDIENCES, STATUS_LABEL, imageFor, type UseCase } from "./data";
import { useInternalLink } from "./UseCaseChrome";

const AUDIENCE_LABEL = Object.fromEntries(AUDIENCES.map((a) => [a.id, a.label]));

export function UseCaseCard({ item, featured = false, eager = false }: { item: UseCase; featured?: boolean; eager?: boolean }) {
  const onLink = useInternalLink();
  return (
    <a className={`uc-card${featured ? " uc-card-featured" : ""}`} href={`/use-cases/${item.slug}`} onClick={onLink}>
      <span className="uc-card-media">
        <img
          src={imageFor(item, featured ? "hero" : "card")}
          alt=""
          width={featured ? 1600 : 800}
          height={featured ? 1200 : 600}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
        />
      </span>
      <span className="uc-card-body">
        <span className="uc-card-meta">
          <span className="uc-audience">{AUDIENCE_LABEL[item.audience]}</span>
          {item.status === "soon" || featured ? <span className={`uc-status uc-status-${item.status}`}>{featured && item.status === "live" ? "New" : STATUS_LABEL[item.status]}</span> : null}
        </span>
        <span className="uc-card-title">{item.title}</span>
        <span className="uc-card-summary">{item.summary}</span>
      </span>
    </a>
  );
}
