import { useEffect, type RefObject } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

// Explanation motion only. All copy and examples are visible before enhancement.
export function useLandingMotion(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!root.current) return;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    let disposed = false;
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(".landing-hero-visual .story-document", { y: 24, rotation: -2, duration: 0.8, ease: "power3.out" });
      gsap.from(".hero-payment-slip", { x: 24, duration: 0.8, delay: 0.08, ease: "power3.out" });
      root.current?.querySelectorAll<HTMLElement>(".story-chapter").forEach((chapter) => {
        gsap.from(chapter.querySelector(".story-document"), {
          y: 44, rotation: 2, ease: "none",
          scrollTrigger: { trigger: chapter, start: "top bottom", end: "center center", scrub: true },
        });
      });
    }, root);
    // Lenis is the only smooth-scroll engine. Touch and reduced motion stay native.
    media.add("(min-width: 961px) and (pointer: fine) and (prefers-reduced-motion: no-preference)", () => {
      const lenis = new Lenis({ anchors: true, duration: 0.8 });
      lenis.on("scroll", ScrollTrigger.update);
      const tick = (seconds: number) => lenis.raf(seconds * 1000);
      gsap.ticker.add(tick);
      return () => { gsap.ticker.remove(tick); lenis.destroy(); };
    }, root);
    void document.fonts.ready.then(() => { if (!disposed) ScrollTrigger.refresh(); });
    return () => { disposed = true; media.revert(); };
  }, [root]);
}
