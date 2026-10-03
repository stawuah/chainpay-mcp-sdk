import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { PetAction, PetState } from "../../../../shared/pet";
import type { Expression, Motion } from "../RobotModel";
import { RobotStill } from "../RobotStill";

const RobotCanvas = lazy(() => import("../RobotCanvas"));
const RoomCanvas = lazy(() => import("./RoomCanvas"));
import { CanvasBoundary } from "../CanvasBoundary";
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => { const media = matchMedia("(prefers-reduced-motion: reduce)"); const update = () => setReduced(media.matches); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  return reduced;
}
export function SharedRobot({ state, action, reactionId = 0, room = false }: { state: PetState | null; action: PetAction | null; room?: boolean; reactionId?: number }) {
  const reduced = useReducedMotion();
  const [ambient, setAmbient] = useState(true);
  useEffect(() => { if (action) setAmbient(true); const timer = setTimeout(() => setAmbient(false), action ? 2_000 : 1_000); return () => clearTimeout(timer); }, [action, reactionId]);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  const webgl = useMemo(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl2"); gl?.getExtension("WEBGL_lose_context")?.loseContext(); return Boolean(gl); } catch { return false; } }, []);
  const expression: Expression = action ? "happy" : state?.sleeping ? "sleep" : state?.lowPower || (state && Math.min(state.needs.battery, state.needs.joy) < 35) ? "low" : state?.mood === "bright" ? "happy" : "idle";
  const motion: Motion = reduced ? "none" : action === "charge" ? "eat" : action === "polish" ? "shake" : action === "ball" || action === "game" || action === "play" ? "spin" : "none";
  const look = action === "pat" ? { x: 0.8, y: 0.4 } : state?.favorite === "collect" ? { x: 0.8, y: 0.4 } : state?.favorite === "polish" ? { x: 0, y: 0.7 } : state?.favorite === "ball" ? { x: 0.6, y: -0.5 } : { x: 0, y: 0 };
  const fallback = room ? <svg className="community-room-still" viewBox="0 0 800 470" aria-hidden="true"><rect width="800" height="470" fill="#f4f7ff" /><path d="M0 330H800V470H0Z" fill="#e7edfc" /><ellipse cx="400" cy="378" rx="210" ry="54" fill="#bbcfff" /><ellipse cx="145" cy="365" rx="48" ry="20" fill="#0052ff" /><circle cx={state?.favorite === "ball" ? 500 : 635} cy="372" r="26" fill="#0052ff" /><path d="M630 180H765" stroke="#fff" strokeWidth="14" />{(state?.props ?? []).slice(0, 3).map((p, i) => <path key={p} d={`M${650 + i * 36} 138l13 18-13 18-13-18Z`} fill="#e6b645" />)}<rect x="200" y="380" width="62" height="38" rx="5" fill="#14213d" /><svg x={action === "pat" ? "245" : "235"} y="65" width="330" height="330"><RobotStill expression={expression} /></svg>{state && state.needs.cleanliness < 50 && action !== "polish" ? <g fill="#8492ab"><circle cx="354" cy="183" r="3" /><circle cx="444" cy="195" r="3" /></g> : null}</svg> : <RobotStill expression={expression} />;
  if (!webgl) return fallback;
  return <CanvasBoundary fallback={fallback}><Suspense fallback={fallback}>{room ? <RoomCanvas state={action === "polish" && state ? { ...state, needs: { ...state.needs, cleanliness: 100 } } : state} expression={expression} motion={motion} reactionId={reactionId} animate={!reduced && visible && ambient} look={look} /> : <RobotCanvas expression={expression} motion={motion} reactionId={reactionId} animate={!reduced && visible && ambient} look={look} gear={[]} />}</Suspense></CanvasBoundary>;
}
