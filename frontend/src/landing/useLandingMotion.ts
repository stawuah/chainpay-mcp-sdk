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
      gsap.to(".landing-hero-visual", { y: -60, scale: 0.96, ease: "none",
        scrollTrigger: { trigger: ".landing-hero", start: "top top", end: "bottom top", scrub: true } });
      [".story-intro", "#developers", ".landing-faq", ".landing-cta"].forEach((selector) => {
        gsap.from(selector, { y: 36, scale: selector === ".landing-cta" ? 0.96 : 1,
          ease: "none", scrollTrigger: { trigger: selector, start: "top bottom", end: "top 65%", scrub: true } });
      });
      gsap.from(".landing-cta > :not(button)", { y: 18, stagger: 0.08, duration: 0.7, ease: "power3.out",
        scrollTrigger: { trigger: ".landing-cta", start: "top 80%", toggleActions: "play none none reverse" } });
    }, root);
    // A single stationary document evolves while the original chapters remain
    // in reading order. The visual duplicate is hidden from assistive technology.
    media.add("(min-width: 1100px) and (min-height: 800px) and (prefers-reduced-motion: no-preference)", () => {
      const sequence = root.current!.querySelector<HTMLElement>(".story-sequence")!;
      sequence.classList.add("is-morphing");
      const states = Array.from(sequence.querySelectorAll<HTMLElement>(".story-morph-state"));
      const chapters = Array.from(sequence.querySelectorAll<HTMLElement>(".story-chapter"));
      gsap.set(states.slice(1), { opacity: 0, y: 28, scale: 0.97 });
      ScrollTrigger.create({ trigger: sequence.querySelector(".story-morph"), start: "top 110px",
        endTrigger: sequence, end: "bottom bottom", pin: true, pinSpacing: false });
      const timeline = gsap.timeline({ scrollTrigger: {
        trigger: chapters[0], start: "center center", endTrigger: chapters[3], end: "center center", scrub: true,
      }});
      states.forEach((state, index) => {
        if (!index) return;
        const position = index - 0.4;
        timeline.to(states[index - 1], { opacity: 0, y: -20, scale: 0.97, duration: 0.4, ease: "power2.inOut" }, position)
          .to(state, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "power2.inOut" }, position);
      });
      timeline.to({}, { duration: 0.4 });
      gsap.fromTo(".story-morph-progress > span", { scaleX: 0 }, { scaleX: 1, ease: "none",
        scrollTrigger: { trigger: chapters[0], start: "center center", endTrigger: chapters[3], end: "center center", scrub: true } });
      return () => { sequence.classList.remove("is-morphing"); };
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
