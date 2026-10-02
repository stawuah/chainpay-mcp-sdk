import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BatteryCharging, BookOpen, Pin, PinOff, ChevronLeft, ChevronRight, Clock, Coins, EyeOff, Gamepad2, HandHeart, Lock, Pointer, Shirt, Sparkles, X } from "lucide-react";
import { COOLDOWN_MS, NEEDS, type Need, type PetAction, type PetSnapshot } from "./sim/needs";
import { GEAR, levelOf, todaySoFar, unlockedGear, type Bond, type Gear } from "./sim/bond";
import { AllowanceGame } from "./play/AllowanceGame";

export type PanelView = "main" | "diary" | "gear" | "game";

// His panel, per the design council ruling of 2026-10-03
// (_bmad-output/design-council/pet-panel-ruling-2026-10-03.md, P1–P20).
// One job: how he is and what he wants. One action: the suggested care tile.

const CARE: Record<Need, { action: PetAction; label: string; icon: ReactNode; words: [string, string, string, string] }> = {
  battery: { action: "feed", label: "Charge", icon: <BatteryCharging size={18} strokeWidth={1.75} />, words: ["Full", "Good", "Low", "Almost flat"] },
  joy: { action: "play", label: "Play", icon: <Gamepad2 size={18} strokeWidth={1.75} />, words: ["Buzzing", "Good", "Bored", "Lonely"] },
  clean: { action: "clean", label: "Polish", icon: <Sparkles size={18} strokeWidth={1.75} />, words: ["Spotless", "Good", "Dusty", "Grimy"] },
};

const NEED_NAME: Record<Need, string> = { battery: "Battery", joy: "Joy", clean: "Shine" };

function wordFor(need: Need, value: number) {
  const [full, good, low, worst] = CARE[need].words;
  if (value >= 80) return full;
  if (value >= 50) return good;
  if (value >= 25) return low;
  return worst;
}

export function cooldownLeft(snapshot: PetSnapshot, action: PetAction, now: number) {
  const last = snapshot.lastAction[action];
  if (last === undefined) return 0;
  return Math.max(0, COOLDOWN_MS[action] - (now - last));
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** P4: lowest need that is not cooling down; nothing if he is fine. */
function suggestedNeed(snapshot: PetSnapshot, now: number): Need | null {
  let best: Need | null = null;
  for (const need of NEEDS) {
    if (cooldownLeft(snapshot, CARE[need].action, now) > 0) continue;
    if (best === null || snapshot.needs[need] < snapshot.needs[best]) best = need;
  }
  if (best === null || snapshot.needs[best] >= 80) return null;
  return best;
}

type Placement = { x: number; y: number; origin: string };

const GAP = 8;
const EDGE = 16;

function place(anchor: DOMRect, panel: { width: number; height: number }): Placement {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - EDGE - panel.width);
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), vh - EDGE - panel.height);
  let x: number;
  let y: number;
  if (anchor.top - GAP - panel.height >= EDGE) {
    x = clampX(cx - panel.width / 2);
    y = anchor.top - GAP - panel.height;
  } else if (anchor.bottom + GAP + panel.height <= vh - EDGE) {
    x = clampX(cx - panel.width / 2);
    y = anchor.bottom + GAP;
  } else if (anchor.left - GAP - panel.width >= EDGE) {
    x = anchor.left - GAP - panel.width;
    y = clampY(cy - panel.height / 2);
  } else if (anchor.right + GAP + panel.width <= vw - EDGE) {
    x = anchor.right + GAP;
    y = clampY(cy - panel.height / 2);
  } else {
    x = clampX((vw - panel.width) / 2);
    y = clampY((vh - panel.height) / 2);
  }
  // No tail: the panel grows out of him instead.
  const ox = Math.min(Math.max(cx - x, 0), panel.width);
  const oy = Math.min(Math.max(cy - y, 0), panel.height);
  return { x, y, origin: `${ox}px ${oy}px` };
}

type Props = {
  view: PanelView;
  onView: (view: PanelView) => void;
  bond: Bond;
  onToss: () => void;
  onGameFinish: (won: boolean) => void;
  onToggleGear: (item: Gear) => void;
  pinned: boolean;
  onTogglePin: () => void;
  open: boolean;
  sheet: boolean;
  anchor: HTMLElement | null;
  snapshot: PetSnapshot;
  now: number;
  stage: string;
  asleepUntil: string | null;
  line: string;
  onCare: (action: PetAction) => void;
  onQuick: (action: "pet" | "poke") => void;
  onHide: () => void;
  onClose: (returnFocus: boolean) => void;
  onSheetRect: (rect: DOMRect | null) => void;
};

export function PetPanel(props: Props) {
  const { open, sheet, anchor, snapshot, now, stage, asleepUntil, line, onCare, onQuick, onHide, onClose, onSheetRect } = props;
  const { view, onView, bond, onToss, onGameFinish, onToggleGear, pinned, onTogglePin } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Keep the panel mounted through its exit transition.
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Measure before paint, then place next to him and fade in.
  useLayoutEffect(() => {
    if (!open || !mounted || !panel.current) return;
    const measure = () => {
      if (!panel.current) return;
      if (sheet) {
        setPlacement(null);
        onSheetRect(panel.current.getBoundingClientRect());
        return;
      }
      onSheetRect(null);
      if (!anchor) return;
      setPlacement(place(anchor.getBoundingClientRect(), { width: panel.current.offsetWidth, height: panel.current.offsetHeight }));
    };
    measure();
    const frame = requestAnimationFrame(() => setShown(true));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [open, mounted, sheet, anchor, onSheetRect, view]);

  // P16/P17: focus in on open, Escape, outside press, focus leaving.
  // Focus moves in once the panel is placed and visible; a panel still hidden
  // for measuring cannot take focus.
  useEffect(() => {
    if (open && shown) panel.current?.focus({ preventScroll: true });
  }, [open, shown]);

  useEffect(() => {
    if (!open || !mounted) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (panel.current?.contains(target) || anchor?.contains(target));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(true);
    };
    const onDown = (event: PointerEvent) => {
      if (!inside(event.target)) onClose(false);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget && !inside(event.relatedTarget)) onClose(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    panel.current?.addEventListener("focusout", onFocusOut);
    const node = panel.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      node?.removeEventListener("focusout", onFocusOut);
    };
  }, [open, mounted, anchor, onClose]);

  if (!mounted) return null;

  const suggested = suggestedNeed(snapshot, now);
  const style = sheet
    ? undefined
    : placement
      ? { left: placement.x, top: placement.y, transformOrigin: placement.origin }
      : { left: 0, top: 0, visibility: "hidden" as const };

  return createPortal(
    <div
      ref={panel}
      className={`cp-pet-panel${sheet ? " is-sheet" : ""}${shown && open ? " is-shown" : ""}`}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-labelledby="cp-pet-title"
      aria-describedby="cp-pet-line"
      tabIndex={-1}
      id="cp-pet-panel"
    >
      {view === "main" ? (
        <MainView {...props} suggested={suggested} />
      ) : view === "diary" ? (
        <DiaryView bond={bond} onBack={() => onView("main")} />
      ) : view === "gear" ? (
        <GearView bond={bond} onBack={() => onView("main")} onToggle={onToggleGear} />
      ) : (
        <AllowanceGame onBack={() => onView("main")} onFinish={onGameFinish} />
      )}

      <footer className="cp-pet-panel-foot">
        <span>Remembers you on this device</span>
        <span className="cp-pet-foot-actions">
          <button type="button" className="cp-pet-ghost" aria-pressed={pinned} onClick={onTogglePin}>
            {pinned ? <PinOff size={14} strokeWidth={1.75} aria-hidden="true" /> : <Pin size={14} strokeWidth={1.75} aria-hidden="true" />}
            {pinned ? "Unpin" : "Pin here"}
          </button>
          <button type="button" className="cp-pet-ghost" onClick={onHide}>
            <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" /> Hide
          </button>
        </span>
      </footer>
    </div>,
    document.body,
  );
}

type MainProps = Props & { suggested: Need | null };

function MainView(props: MainProps) {
  const { snapshot, now, stage, asleepUntil, line, onCare, onQuick, onClose, bond, onView, onToss, suggested } = props;
  const level = levelOf(bond.xp);
  const gearCount = unlockedGear(bond.xp).length;
  return (
    <>
      <header className="cp-pet-panel-head">
        <div>
          <div className="cp-pet-title-row">
            <h2 id="cp-pet-title" className="cp-pet-title">???</h2>
            <span className="cp-pet-chip">{level.label}</span>
          </div>
          <p className="cp-pet-meta">
            No name yet · {stage}
            {bond.streak > 1 ? ` · ${bond.streak}-day streak` : ""}
            {asleepUntil ? ` · Asleep until ${asleepUntil}` : ""}
          </p>
        </div>
        <button type="button" className="cp-pet-close" aria-label="Close" onClick={() => onClose(true)}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </header>

      <p id="cp-pet-line" className="cp-pet-voice" aria-live="polite">{line}</p>

      <div className="cp-pet-tiles">
        {NEEDS.map((need) => {
          const care = CARE[need];
          const value = snapshot.needs[need];
          const wait = cooldownLeft(snapshot, care.action, now);
          const word = wordFor(need, value);
          const classes = ["cp-pet-tile"];
          if (suggested === need) classes.push("is-suggested");
          if (wait > 0) classes.push("is-cooling");
          if (value < 25) classes.push("is-critical");
          return (
            <button
              key={need}
              type="button"
              className={classes.join(" ")}
              aria-disabled={wait > 0 && need !== "joy" ? "true" : undefined}
              aria-label={`${care.label}. ${NEED_NAME[need]}: ${wait > 0 ? `ready in ${minutes(wait)} minutes` : word}.`}
              onClick={() => (need === "joy" ? onView("game") : onCare(care.action))}
            >
              <span className="cp-pet-tile-top">
                {care.icon}
                <span>{care.label}</span>
              </span>
              <span className="cp-pet-tile-status">
                {wait > 0 ? (
                  <>
                    <Clock size={12} strokeWidth={1.75} aria-hidden="true" /> Ready in {minutes(wait)}m
                  </>
                ) : (
                  word
                )}
              </span>
              <span
                className="cp-pet-meter"
                role="meter"
                aria-label={NEED_NAME[need]}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(value)}
                aria-valuetext={word}
              >
                <span style={{ width: `${value}%` }} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="cp-pet-quick">
        <button type="button" className="cp-pet-pill" onClick={() => onQuick("pet")}>
          <HandHeart size={14} strokeWidth={1.75} aria-hidden="true" /> Pat
        </button>
        <button type="button" className="cp-pet-pill" onClick={() => onQuick("poke")}>
          <Pointer size={14} strokeWidth={1.75} aria-hidden="true" /> Poke
        </button>
        <button type="button" className="cp-pet-pill" onClick={onToss}>
          <Coins size={14} strokeWidth={1.75} aria-hidden="true" /> Toss a coin
        </button>
      </div>

      <nav className="cp-pet-links" aria-label="More">
        <button type="button" className="cp-pet-link" onClick={() => onView("diary")}>
          <BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Diary</span>
          <span className="cp-pet-link-meta">{bond.diary.length + (todaySoFar(bond) ? 1 : 0)}</span>
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="cp-pet-link" onClick={() => onView("gear")}>
          <Shirt size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Gear</span>
          <span className="cp-pet-link-meta">{gearCount} of {GEAR.length}</span>
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </nav>
    </>
  );
}

function ViewHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="cp-pet-view-head">
      <button type="button" className="cp-pet-back" onClick={onBack} aria-label="Back">
        <ChevronLeft size={16} strokeWidth={1.75} />
      </button>
      <h3 id="cp-pet-title">{title}</h3>
    </header>
  );
}

const DIARY_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function diaryDate(day: string) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return DIARY_DATE.format(new Date(y, m - 1, d));
}

function DiaryView({ bond, onBack }: { bond: Bond; onBack: () => void }) {
  const today = todaySoFar(bond);
  const entries = [...(today ? [{ ...today, today: true }] : []), ...[...bond.diary].reverse().map((entry) => ({ ...entry, today: false }))];
  return (
    <>
      <ViewHead title="Diary" onBack={onBack} />
      {entries.length === 0 ? (
        <p className="cp-pet-empty" id="cp-pet-line">nothing yet. come back tomorrow and there'll be a page.</p>
      ) : (
        <ol className="cp-pet-diary" id="cp-pet-line">
          {entries.map((entry) => (
            <li key={entry.day}>
              <span className="cp-pet-diary-day">{entry.today ? "Today so far" : diaryDate(entry.day)}</span>
              <p>{entry.text}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function GearView({ bond, onBack, onToggle }: { bond: Bond; onBack: () => void; onToggle: (item: Gear) => void }) {
  const level = levelOf(bond.xp);
  const unlocked = unlockedGear(bond.xp);
  const progress = level.next ? (bond.xp - level.fromXp) / (level.next.fromXp - level.fromXp) : 1;
  return (
    <>
      <ViewHead title="Gear" onBack={onBack} />
      <div className="cp-pet-level" id="cp-pet-line">
        <div className="cp-pet-level-row">
          <strong>{level.label}</strong>
          <span>{level.next ? `${level.toNext} XP to ${level.next.label}` : "Max level"}</span>
        </div>
        <span className="cp-pet-meter" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </span>
        <p className="cp-pet-level-hint">Care, pats, squashed bugs and answered calls all count. Up to 40 XP a day.</p>
      </div>
      <ul className="cp-pet-gear">
        {GEAR.map((entry) => {
          const isUnlocked = unlocked.includes(entry.gear);
          const on = bond.gearOn.includes(entry.gear);
          const needs = LEVEL_LABEL[entry.unlock];
          return (
            <li key={entry.gear}>
              <button
                type="button"
                className={`cp-pet-gear-item${on ? " is-on" : ""}`}
                aria-pressed={isUnlocked ? on : undefined}
                aria-disabled={isUnlocked ? undefined : "true"}
                onClick={() => isUnlocked && onToggle(entry.gear)}
              >
                <span>{entry.label}</span>
                <span className="cp-pet-gear-state">
                  {isUnlocked ? (on ? "Wearing" : "Off") : (
                    <>
                      <Lock size={12} strokeWidth={1.75} aria-hidden="true" /> {needs}
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const LEVEL_LABEL: Record<string, string> = { regular: "Regular", friend: "Friend", best: "Best friend" };
