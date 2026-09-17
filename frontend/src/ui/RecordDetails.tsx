import { useEffect, useRef, type ReactNode } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import "./record-details.css";

/** Shared content frame for a record's modal preview and addressable page. */
export function RecordDetails({ open, fullPage = false, title, children, onClose, fullPageHref, onOpenFullPage }: {
  open: boolean;
  fullPage?: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  fullPageHref?: string;
  onOpenFullPage?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (fullPage) heading.current?.focus();
  }, [fullPage]);

  if (fullPage) return <section className="cp-record-page">
    <Button type="button" variant="secondary" label="Back to spending permissions" onClick={onClose} />
    <h2 ref={heading} tabIndex={-1}>{title}</h2>
    {children}
  </section>;

  return <Dialog isOpen={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
    position={{ top: 0, end: 0 }} width="min(580px, 100vw)" maxHeight="100dvh"
    padding={0} className="cp-record-panel" style={{ height: "100dvh" }} purpose="info">
    <Layout padding={6} header={<DialogHeader className="cp-record-header" title={title} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} />}>
      <LayoutContent>
        {fullPageHref && <a className="cp-record-full-link" href={fullPageHref} onClick={(event) => {
          if (onOpenFullPage && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
            event.preventDefault(); onOpenFullPage();
          }
        }}>Open full page ↗</a>}
        {children}
      </LayoutContent>
    </Layout>
  </Dialog>;
}
