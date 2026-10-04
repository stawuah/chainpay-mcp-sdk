import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { PET_STATE_EVENT, type PetPresence } from "../pet-presence";

// The hero's motion lane: a payment stays inside its boundary and leaves a receipt.
// Ruling: _bmad-output/design-council/landing-brand-ruling-2026-10-04.md (B7, B12, B13).
// It plays only while nothing blocks it, and it pauses (never dims) otherwise. The
// clip is not requested until the first allowed play, so reduced motion and
// Save-Data never download it. A manual pause lasts for the session.

const CLIP = "/landing/hero-boundary.mp4";
const POSTER = "/landing/hero-boundary-poster.webp";
const MANUAL_KEY = "chainpay.hero.motion";
// The pet loads lazily after the page. If he is on, wait for him to say hello
// before the first play; if he never shows up, play anyway after this long.
const PET_WAIT_MS = 6_000;

type Manual = "paused" | "played" | null;

function readManual(): Manual {
  try {
    const value = window.sessionStorage.getItem(MANUAL_KEY);
    return value === "paused" || value === "played" ? value : null;
  } catch {
    return null;
  }
}

function writeManual(value: Exclude<Manual, null>) {
  try {
    window.sessionStorage.setItem(MANUAL_KEY, value);
  } catch {
    // Memory only.
  }
}

function prefersStill() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches || connection?.saveData === true;
}

function petExpected() {
  if (import.meta.env.VITE_CHAINPAY_PET === "off") return false;
  try {
    return window.localStorage.getItem("chainpay.pet.hidden") !== "1";
  } catch {
    return true;
  }
}

function petBlocks({ greeting, speaking, perch }: PetPresence, hero: Element | null) {
  return greeting || speaking || Boolean(perch && hero?.contains(perch));
}

export function HeroLoop() {
  const lane = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [manual, setManual] = useState<Manual>(readManual);
  const [still, setStill] = useState(prefersStill);
  const [visible, setVisible] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [pet, setPet] = useState(false);
  // Before the pet has announced himself, hold the first play (unless he is off).
  const [awaitingPet, setAwaitingPet] = useState(() => petExpected() && !document.documentElement.hasAttribute("data-pet-ready"));

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setStill(prefersStill());
    reduce.addEventListener("change", onChange);
    return () => reduce.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const node = lane.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry && entry.intersectionRatio >= 0.25)), { threshold: [0, 0.25] });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const hero = () => lane.current?.closest(".landing-hero") ?? null;
    const html = document.documentElement;
    setPet(petBlocks({ greeting: html.hasAttribute("data-pet-greeting"), speaking: html.hasAttribute("data-pet-speaking"), perch: document.querySelector("[data-pet-perched]") }, hero()));
    const onPet = (event: Event) => {
      setAwaitingPet(false);
      setPet(petBlocks((event as CustomEvent<PetPresence>).detail, hero()));
    };
    const giveUp = window.setTimeout(() => setAwaitingPet(false), PET_WAIT_MS);
    window.addEventListener(PET_STATE_EVENT, onPet);
    return () => {
      window.clearTimeout(giveUp);
      window.removeEventListener(PET_STATE_EVENT, onPet);
    };
  }, []);

  const userPaused = manual === "paused" || (manual === null && still);
  const playing = !userPaused && visible && !hidden && !pet && !awaitingPet;

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (!playing) {
      node.pause();
      return;
    }
    if (!node.getAttribute("src")) node.src = CLIP;
    // A failed play keeps the poster on screen; nothing else to do.
    node.play().catch(() => undefined);
  }, [playing]);

  function toggle() {
    const next = userPaused ? "played" : "paused";
    writeManual(next);
    setManual(next);
  }

  return (
    <>
      <div ref={lane} className="hero-lane">
        <video ref={video} muted loop playsInline preload="none" poster={POSTER} aria-hidden="true" width={1280} height={400} />
      </div>
      <div className="hero-motion-row">
        <button type="button" className="asset-strip-pause hero-motion-toggle" onClick={toggle}>
          {userPaused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {userPaused ? "Play motion" : "Pause motion"}
        </button>
        <p className="hero-product-caption">A little autonomy. A clear boundary.</p>
      </div>
    </>
  );
}
