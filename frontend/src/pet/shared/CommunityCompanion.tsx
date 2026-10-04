import { useEffect, useRef, useState } from "react";
import { communityPet, useCommunityPet } from "./store";
import { SharedRobot, useReducedMotion } from "./SharedRobot";
import { moodLine, Needs } from "./CommunityRoom";
import { pinAt, useRoamer, type Pin } from "../roam/roamer";
import type { PetAction } from "../../../../shared/pet";
import { setPetSuppressed } from "../../pet-prefs";
import "./community.css";

function readPin(): Pin | null { try { const p = JSON.parse(localStorage.getItem("chainpay.pet.pin") ?? "null"); return p && Number.isFinite(p.fx) && Number.isFinite(p.fy) ? p : null; } catch { return null; } }
export default function CommunityCompanion({ routeKind, routeKey, onHide }: { routeKind: string; routeKey: string; onHide: () => void; quiet?: boolean }) {
  const [reactionId, setReactionId] = useState(0);
  const [open, setOpen] = useState(false), [action, setAction] = useState<PetAction | null>(null), [pin, setPin] = useState(readPin);
  // The on/off toggle steps aside while his panel is open (B16b).
  useEffect(() => { setPetSuppressed("community-panel", open, "toggle"); return () => setPetSuppressed("community-panel", false); }, [open]);
  const view = useCommunityPet(open), reduced = useReducedMotion();
  const body = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [small, setSmall] = useState(() => innerWidth <= 600);
  useEffect(() => { const resize = () => setSmall(innerWidth <= 600); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const size = small ? 90 : 120;
  const { position, pause, resume } = useRoamer({ size, roam: routeKind === "landing" && !reduced && !small, pin });
  useEffect(() => { setOpen(false); }, [routeKey]);
  useEffect(() => { if (!action) return; const t = setTimeout(() => setAction(null), 2_500); return () => clearTimeout(t); }, [action, reactionId]);
  useEffect(() => {
    if (!open) { resume(1_500); return; }
    pause(); panel.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); body.current?.focus(); } };
    const outside = (event: PointerEvent | FocusEvent) => { if (!panel.current?.contains(event.target as Node) && !body.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", close); window.addEventListener("pointerdown", outside); window.addEventListener("focusin", outside);
    return () => { window.removeEventListener("keydown", close); window.removeEventListener("pointerdown", outside); window.removeEventListener("focusin", outside); };
  }, [open, pause, resume]);
  const act = (next: PetAction) => { setAction(next); setReactionId(id => id + 1); void communityPet.act(next); };
  return <>
    <div className="community-companion" data-reaction={reactionId} data-mode={pin ? "pinned" : position.mode} style={{ left: position.x, top: position.y, width: size, height: size, transition: reduced || !position.glide ? "none" : "left 1.2s ease, top 1.2s ease" }}><button ref={body} aria-label="Open Bam Bam" aria-haspopup="dialog" aria-controls="community-panel" aria-expanded={open} onClick={() => setOpen(!open)}><SharedRobot state={view.state} action={action} reactionId={reactionId} /></button></div>
    {open ? <div id="community-panel" className="community-panel" role="dialog" aria-label="Bam Bam" tabIndex={-1} ref={panel}><div className="community-panel-head"><strong>Bam Bam</strong><button aria-label="Close Bam Bam's panel" onClick={() => { setOpen(false); body.current?.focus(); }}>×</button></div><p>{moodLine(view.state)}</p><Needs state={view.state} /><div className="community-actions"><button onClick={() => act("charge")}>Charge</button><button onClick={() => act("play")}>Play</button><button onClick={() => act("polish")}>Polish</button><button onClick={() => act("pat")}>Pat</button></div><p role="status" className="community-small">{view.status === "offline" ? "Reconnecting. Last confirmed room shown. " : ""}{view.message}</p>{view.pending ? <button onClick={() => void communityPet.retry()}>Retry unconfirmed action</button> : null}<a className="community-primary" href="/pet">Visit our room ↗</a><div className="community-panel-preferences"><button onClick={() => { const next = pin ? null : pinAt(position.x, position.y); setPin(next); try { if (next) localStorage.setItem("chainpay.pet.pin", JSON.stringify(next)); else localStorage.removeItem("chainpay.pet.pin"); } catch { /* Memory only. */ } }}>{pin ? "Unpin" : "Pin here"}</button><button onClick={onHide}>Hide</button></div></div> : null}
  </>;
}
