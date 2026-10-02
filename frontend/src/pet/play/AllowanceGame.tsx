import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { GAME_COPY } from "./lines";

// Allowance: catch falling coins to spend exactly 10 USDC in 20 seconds.
// Anything that would go over the limit is blocked, which is the whole point
// of a mandate. Amounts are kept in cents so the total is always exact.

const LIMIT_CENTS = 1_000;
const DURATION_MS = 20_000;
const AREA_H = 200;
const CATCHER_W = 52;
const ITEM = 34;
const VALUES = [50, 100, 100, 200, 200, 450];

type Item = { id: number; x: number; y: number; cents: number; over: boolean; speed: number };
type Phase = "ready" | "playing" | "won" | "lost";

const usdc = (cents: number) => (cents / 100).toFixed(2);

export function AllowanceGame({
  onBack,
  onFinish,
}: {
  onBack: () => void;
  onFinish: (won: boolean) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [items, setItems] = useState<Item[]>([]);
  const [catcherX, setCatcherX] = useState(0.5);
  const [spent, setSpent] = useState(0);
  const [left, setLeft] = useState(DURATION_MS);
  const [blockedAt, setBlockedAt] = useState(0);
  const [announce, setAnnounce] = useState("");
  const game = useRef({ items: [] as Item[], spent: 0, catcherX: 0.5, keys: 0, nextId: 1, lastSpawn: 0, start: 0, last: 0 });

  const finish = useCallback(
    (won: boolean) => {
      setPhase(won ? "won" : "lost");
      setAnnounce(won ? GAME_COPY.won : GAME_COPY.lostUnder(usdc(game.current.spent)));
      onFinish(won);
    },
    [onFinish],
  );

  const start = () => {
    const now = performance.now();
    game.current = { items: [], spent: 0, catcherX: 0.5, keys: 0, nextId: 1, lastSpawn: now - 600, start: now, last: now };
    setItems([]);
    setSpent(0);
    setLeft(DURATION_MS);
    setCatcherX(0.5);
    setAnnounce("");
    setPhase("playing");
    area.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (phase !== "playing") return;
    let frame = 0;
    const loop = (now: number) => {
      const g = game.current;
      const width = area.current?.clientWidth ?? 264;
      const dt = Math.min(0.05, (now - g.last) / 1000);
      g.last = now;
      if (g.keys !== 0) g.catcherX = Math.min(1, Math.max(0, g.catcherX + (g.keys * 300 * dt) / width));

      if (now - g.lastSpawn > 650) {
        g.lastSpawn = now;
        const over = Math.random() < 0.14;
        g.items.push({
          id: g.nextId++,
          x: Math.random() * (width - ITEM),
          y: -ITEM,
          cents: over ? 5_000 : VALUES[Math.floor(Math.random() * VALUES.length)]!,
          over,
          speed: 95 + Math.random() * 45,
        });
      }

      const catcherLeft = g.catcherX * (width - CATCHER_W);
      const catchY = AREA_H - 30 - ITEM;
      const remaining: Item[] = [];
      for (const item of g.items) {
        const y = item.y + item.speed * dt;
        const crossing = item.y < catchY && y >= catchY;
        const overlaps = item.x + ITEM > catcherLeft && item.x < catcherLeft + CATCHER_W;
        if (crossing && overlaps) {
          if (item.over || g.spent + item.cents > LIMIT_CENTS) {
            setBlockedAt(now);
            setAnnounce(`${GAME_COPY.blocked}: ${usdc(item.cents)} USDC`);
          } else {
            g.spent += item.cents;
            setSpent(g.spent);
            setAnnounce(`${usdc(g.spent)} of 10 USDC`);
          }
          continue;
        }
        if (y < AREA_H) remaining.push({ ...item, y });
      }
      g.items = remaining;
      setItems(remaining);
      setCatcherX(g.catcherX);
      const timeLeft = Math.max(0, DURATION_MS - (now - g.start));
      setLeft(timeLeft);

      if (g.spent === LIMIT_CENTS) return finish(true);
      if (timeLeft === 0) return finish(false);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase, finish]);

  const steer = (clientX: number) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect || phase !== "playing") return;
    const x = Math.min(1, Math.max(0, (clientX - rect.left - CATCHER_W / 2) / (rect.width - CATCHER_W)));
    game.current.catcherX = x;
    setCatcherX(x);
  };

  const blocked = performance.now() - blockedAt < 700;

  return (
    <div className="cp-pet-game">
      <header className="cp-pet-view-head">
        <button type="button" className="cp-pet-back" onClick={onBack} aria-label={GAME_COPY.back}>
          <ChevronLeft size={16} strokeWidth={1.75} />
        </button>
        <h3>{GAME_COPY.title}</h3>
        <span className="cp-pet-game-time" aria-hidden="true">{Math.ceil(left / 1000)}s</span>
      </header>

      <div className="cp-pet-game-meter">
        <span>
          <strong>{usdc(spent)}</strong> / 10.00 USDC
        </span>
        <span className="cp-pet-meter" aria-hidden="true">
          <span style={{ width: `${(spent / LIMIT_CENTS) * 100}%` }} />
        </span>
      </div>

      <div
        ref={area}
        className={`cp-pet-game-area${blocked ? " is-blocked" : ""}`}
        style={{ height: AREA_H }}
        tabIndex={0}
        role="application"
        aria-label="Allowance game. Use left and right arrow keys to move."
        onPointerMove={(event) => steer(event.clientX)}
        onPointerDown={(event) => steer(event.clientX)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") game.current.keys = -1;
          else if (event.key === "ArrowRight") game.current.keys = 1;
          else return;
          event.preventDefault();
        }}
        onKeyUp={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") game.current.keys = 0;
        }}
      >
        {items.map((item) => (
          <span
            key={item.id}
            className={`cp-pet-game-coin${item.over ? " is-over" : ""}`}
            style={{ transform: `translate3d(${item.x}px, ${item.y}px, 0)` }}
            aria-hidden="true"
          >
            {item.over ? "50" : usdc(item.cents).replace(/\.00$/, "")}
          </span>
        ))}
        <span
          className="cp-pet-game-catcher"
          style={{ left: `calc(${catcherX} * (100% - ${CATCHER_W}px))` }}
          aria-hidden="true"
        />
        {blocked ? <span className="cp-pet-game-blocked" aria-hidden="true">{GAME_COPY.blocked}</span> : null}

        {phase !== "playing" ? (
          <div className="cp-pet-game-overlay">
            {phase === "ready" ? <p>{GAME_COPY.rules}</p> : null}
            {phase === "won" ? <p><strong>{GAME_COPY.won}</strong></p> : null}
            {phase === "lost" ? <p>{GAME_COPY.lostUnder(usdc(spent))}</p> : null}
            <button type="button" className="cp-pet-primary" onClick={start}>
              {phase === "ready" ? GAME_COPY.start : GAME_COPY.again}
            </button>
          </div>
        ) : null}
      </div>

      <p className="cp-pet-game-note">{GAME_COPY.practice}</p>
      <p className="cp-pet-sr" aria-live="polite">{announce}</p>
    </div>
  );
}
