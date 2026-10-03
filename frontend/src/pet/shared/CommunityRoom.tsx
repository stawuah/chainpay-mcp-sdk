import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, BatteryCharging, Camera, Circle, Hand, Sparkles, Zap } from "lucide-react";
import { BrandLogo } from "../../brand/Brand";
import { AllowanceGame } from "../play/AllowanceGame";
import { SharedRobot } from "./SharedRobot";
import { communityPet, useCommunityPet } from "./store";
import type { PetAction, PetMemoriesResult, PetState } from "../../../../shared/pet";
import { createScrapbook, mergeMemories } from "./scrapbook";
import { drawPhotoScene } from "./photo";
import "../pet.css";
import "./community.css";

const LABEL: Record<PetAction, string> = { charge: "Charge", play: "Play ball", polish: "Polish visor", pat: "Give a pat", ball: "Roll the ball", collect: "Look for treasure", coin: "Toss a coin", game: "Play Allowance", secret: "Find a secret", wake: "Wake gently" };
const LINES: Record<PetAction, string> = { charge: "a little spark. a lot of swagger.", play: "my ball. our ball. my ball.", ball: "again? again.", polish: "yes. this is my good side.", pat: "oh. right there.", collect: "a serious expedition. very shiny business.", coin: "imaginary money. real enthusiasm.", game: "a tiny game. a very good time.", secret: "you found my tiny trick.", wake: "five more… oh, hi." };
export function moodLine(state: PetState | null) {
  if (!state) return "Waiting to hear from our little rascal.";
  if (state.sleeping) return "Ten-minute nap. Dreaming of round things.";
  if (state.lowPower) return "A little worn out. Some care will help.";
  return state.favorite === "ball" ? "Brought the ball over. Subtle as ever." : state.favorite === "collect" ? "Inspecting the treasure shelf. Very important work." : state.favorite === "polish" ? "Presenting the visor. Hint, hint." : "Here for the company. And possibly mischief.";
}
export function Needs({ state }: { state: PetState | null }) {
  return <div className="community-needs">{([['battery', 'Battery'], ['joy', 'Joy'], ['cleanliness', 'Cleanliness']] as const).map(([key, label]) => <div key={key}><div><span>{label}</span><strong>{state ? `${Math.round(state.needs[key])}%` : "—"}</strong></div><meter min="0" max="100" value={state?.needs[key] ?? 0} aria-label={label} /></div>)}</div>;
}
async function exportPhoto(element: HTMLDivElement, caption: string) {
  const source = element.querySelector("canvas");
  const output = document.createElement("canvas");
  output.width = 1200; output.height = 780;
  const context = output.getContext("2d");
  if (!context) throw new Error("Photo not supported");
  context.fillStyle = "#f4f7ff"; context.fillRect(0, 0, 1200, 780);
  if (source) drawPhotoScene(context, source, source.width, source.height);
  else {
    const svg = element.querySelector("svg");
    if (!svg) throw new Error("Scene still loading");
    const serialized = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml" }));
    try { const image = new Image(); image.src = url; await image.decode(); drawPhotoScene(context, image, svg.viewBox.baseVal.width || image.naturalWidth, svg.viewBox.baseVal.height || image.naturalHeight); } finally { URL.revokeObjectURL(url); }
  }
  context.fillStyle = "#14213d"; context.font = "24px sans-serif";
  context.fillText(caption.trim().slice(0, 90) || "A little moment at ChainPay", 40, 750, 1120);
  const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Photo unavailable");
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "chainpay-community-moment.png"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function CommunityRoom() {
  const view = useCommunityPet(true), state = view.state;
  const [reactionId, setReactionId] = useState(0);
  const [action, setAction] = useState<PetAction | null>(null);
  const [line, setLine] = useState("");
  const [game, setGame] = useState(false);
  const [offered, setOffered] = useState(false);
  const [caption, setCaption] = useState("");
  const [photoStatus, setPhotoStatus] = useState("");
  const [scrapbook] = useState(() => createScrapbook(path => communityPet.request<PetMemoriesResult>(path)));
  const memories = useSyncExternalStore(scrapbook.subscribe, scrapbook.get);
  const diaryError = memories.error;
  const [hasLegacySave] = useState(() => { try { return Boolean(localStorage.getItem("chainpay.pet.v1")); } catch { return false; } });
  const [introduced, setIntroduced] = useState(() => { try { return localStorage.getItem("chainpay.pet.community.introduced") === "1"; } catch { return false; } });
  const scene = useRef<HTMLDivElement>(null);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const brush = useRef({ down: false, distance: 0, x: 0, y: 0 });
  const act = useCallback((next: PetAction) => {
    clearTimeout(reactionTimer.current); setAction(next); setReactionId(id => id + 1); setLine(LINES[next]);
    reactionTimer.current = setTimeout(() => setAction(null), 2_500);
    void communityPet.act(next);
  }, []);
  useEffect(() => () => clearTimeout(reactionTimer.current), []);
  useEffect(() => { void scrapbook.refresh(); }, [scrapbook, state?.revision]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden || action || game || document.activeElement?.matches("input,textarea")) return;
      setOffered(true);
      setLine(state?.favorite === "ball" ? "i brought something. it is round." : state?.favorite === "collect" ? "the shelf has excellent taste. mine." : state?.favorite === "polish" ? "does this visor look polishable to you?" : state?.sleeping ? "zzz. no, you take the ball." : "i have scheduled a small moment of nonsense.");
    }, 45_000);
    return () => clearInterval(timer);
  }, [state?.favorite, state?.sleeping, action, game]);
  const suggested = state?.sleeping ? "wake" : state?.suggestedAction ?? "pat";
  const entries = mergeMemories(memories.memories, state?.recentMemories ?? []);
  return <main className="community-room">
    <header className="community-header"><a href="/" aria-label="ChainPay home"><BrandLogo /></a><a href="/"><ArrowLeft size={16} /> Back to ChainPay</a></header>
    <div className="community-heading"><span className="community-eyebrow">THE COMMUNITY ROOM</span><h1>One little robot.<br />All of us.</h1><p>A shared home for our resident rascal. Drop in, make a little mischief, leave a little care.</p></div>
    {!introduced ? <aside className="community-intro"><p><strong>Meet the community robot.</strong> We all care for the same pet. Its habits and scrapbook grow from our time together. {hasLegacySave ? "Your old local save, Hide and Pin preferences stay safe." : "No wallet or sign-up needed. Just a little company."}</p><button onClick={() => { setIntroduced(true); try { localStorage.setItem("chainpay.pet.community.introduced", "1"); } catch { /* memory only */ } }}>Got it</button></aside> : null}
    <div className="community-layout"><section className="community-living" aria-label="Robot's room">
      <div className="community-scene" ref={scene} data-action={action ?? "idle"} data-reaction={reactionId}>
        <SharedRobot state={state} action={action} reactionId={reactionId} room />
        <span className="community-room-label">{state?.sleeping ? "DO NOT DISTURB (MUCH)" : "MAKE YOURSELF AT HOME"}</span>
        <button className="community-brush-target" aria-label="Pat the robot, or drag to polish its visor" onClick={event => { if (event.detail === 0 || brush.current.distance < 30) act("pat"); brush.current.distance = 0; }} onPointerDown={event => { brush.current = { down: true, distance: 0, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const b = brush.current; if (!b.down) return; b.distance += Math.hypot(event.clientX - b.x, event.clientY - b.y); b.x = event.clientX; b.y = event.clientY; }} onPointerUp={() => { if (brush.current.down && brush.current.distance >= 30) act("polish"); brush.current.down = false; }} onPointerCancel={() => { brush.current.down = false; }} />
        {action === "coin" ? <span key={reactionId} className="community-toss" aria-hidden="true">●</span> : null}
      </div>
      <div className="community-room-caption"><p aria-live="polite">“{line || (state?.sleeping ? "zzz. i was keeping that ball warm." : state?.lowPower ? "a little help? my mischief battery is low." : state?.favorite === "collect" ? "just checking on my very important shiny things." : state?.favorite === "polish" ? "my visor has never looked more polishable." : state?.favorite === "ball" ? "i brought something. it is round." : "oh, hi. excellent timing for a little nonsense.")}”</p><span>{state?.favorite ? `Current favorite: ${state.favorite === "collect" ? "shiny collecting" : state.favorite === "polish" ? "polishing" : "the ball"}` : "Finding our favorite things, together."}</span></div>
      {offered ? <div className="community-offer"><p>“psst. i spotted something shiny for our shelf.”</p><button onClick={() => { setOffered(false); act("secret"); }}>Investigate together</button></div> : null}
      <div className="community-props" aria-label="Things in the room"><button onClick={() => act("charge")}><BatteryCharging size={19} /> Charger</button><button onClick={() => act("ball")}><Circle size={19} /> Ball</button><button onClick={() => act("collect")}><Sparkles size={19} /> Treasure shelf</button><a href="#scrapbook">Scrapbook ↗</a></div>
    </section>
    <aside className="community-care" aria-label="Care for the community robot"><span className="community-eyebrow">A LITTLE CARE GOES A LONG WAY</span><h2>{state?.lowPower ? "A gentle pick-me-up?" : state?.sleeping ? "Power nap in progress." : "How’s our little guy?"}</h2><p>{moodLine(state)}</p><Needs state={state} /><button className="community-primary" onClick={() => act(suggested)}><Zap size={18} /> {LABEL[suggested]}</button><div className="community-actions"><button onClick={() => act("charge")}><BatteryCharging size={18} />Charge</button><button onClick={() => act("play")}><Circle size={18} />Play</button><button onClick={() => act("polish")}><Sparkles size={18} />Polish</button><button onClick={() => act("pat")}><Hand size={18} />Pat</button></div><p className="community-small">Drag across the visor to brush, or use the Polish button. Extra play is always welcome, even between shared top-ups.</p><div role="status" className="community-sync">{view.status === "offline" ? "Room connection interrupted. Showing the last confirmed state. " : view.status === "loading" ? "Connecting… " : "Connected to our shared room. "}{view.message}</div>{view.pending ? <button onClick={() => void communityPet.retry()}>Retry unconfirmed action</button> : view.status === "offline" ? <button onClick={() => void communityPet.refresh()}>Reconnect</button> : null}</aside></div>
    <div className="community-bottom"><section className="community-play"><span className="community-eyebrow">STRICTLY FOR FUN</span><h2>A tiny break from being serious.</h2><p>Roll the ball, toss an imaginary coin, or try the Allowance game. No real money. No scores to chase.</p><div className="community-actions"><button onClick={() => act("ball")}>Roll the ball</button><button onClick={() => act("coin")}>Toss a coin</button><button onClick={() => setGame(!game)} aria-expanded={game}>Play Allowance</button></div>{game ? <AllowanceGame onBack={() => setGame(false)} onFinish={() => act("game")} /> : null}<div className="community-photo"><label htmlFor="community-caption">Photo caption <span>(optional)</span></label><input id="community-caption" maxLength={90} value={caption} onChange={event => setCaption(event.target.value)} placeholder="A little moment together" /><button onClick={() => { if (scene.current) void exportPhoto(scene.current, caption).then(() => setPhotoStatus("Photo saved. Just the room and your caption.")).catch(() => setPhotoStatus("The photo couldn't be saved. Please try again.")); }}><Camera size={18} /> Save a photo</button><p role="status">{photoStatus}</p></div></section>
    <section id="scrapbook" className="community-scrapbook"><span className="community-eyebrow">OUR SCRAPBOOK</span><h2>Little things worth keeping.</h2><p>Firsts, finds, changing favorites. A life made together.</p>{entries.length ? <ol>{entries.map(memory => <li key={memory.id}><time dateTime={new Date(memory.at).toISOString()}>{new Date(memory.at).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</time><p>{memory.text}</p></li>)}</ol> : <p>{diaryError ? "The scrapbook is taking a moment to reconnect." : "The first page is waiting for a little moment together."}</p>}{memories?.nextBefore != null ? <button disabled={memories.loading} onClick={() => void scrapbook.more()}>Earlier memories</button> : null}{diaryError ? <button onClick={() => void scrapbook.refresh()}>Retry scrapbook</button> : null}{diaryError && entries.length > 0 ? <p role="status">Couldn't load more memories. These are the last confirmed entries.</p> : null}{memories?.aggregates.map(day => <p className="community-day" key={day.day}><strong>{new Date(day.day * 86_400_000).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</strong> · {Object.entries(day.counts).map(([kind, count]) => `${count} ${kind}`).join(" · ")}</p>)}{state?.props.length ? <p className="community-small">On our treasure shelf: {state.props.join(", ")}.</p> : null}</section></div>
    <footer className="community-footer">No wallet needed. Just a little company.</footer>
  </main>;
}
