import { useEffect, type RefObject } from "react";
import type { gsap as Gsap } from "gsap";

type MatchMedia = ReturnType<typeof Gsap.matchMedia>;

// Explanation motion only. All copy and examples are visible before enhancement.
//
// gsap, ScrollTrigger and Lenis are imported here rather than at module scope.
// LandingPage is imported eagerly by AppShell, so a static import put roughly
// 120 kB of animation library into a chunk that loads on every route —
// including /verify/<pda>, the wallet-free receipt page, which never animates.
// Loading them from inside the effect means they are fetched only when the
// landing actually mounts.
export function useLandingMotion(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!root.current) return;
    let disposed = false;
    let media: MatchMedia | undefined;

    void (async () => {
      const [{ gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
        import("lenis"),
        import("lenis/dist/lenis.css"),
      ]);
      // Unmounted, or the ref was cleared, while the chunk was in flight. Setting
      // up now would leave triggers and a ticker nothing will ever revert.
      if (disposed || !root.current) return;

      gsap.registerPlugin(ScrollTrigger);
      media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".landing-hero-visual .story-document", { y: 24, rotation: -2, duration: 0.8, ease: "power3.out" });
        gsap.from(".hero-payment-slip", { x: 24, duration: 0.8, delay: 0.08, ease: "power3.out" });
        gsap.to(".landing-hero-visual", { y: -60, scale: 0.96, ease: "none",
          scrollTrigger: { trigger: ".landing-hero", start: "top top", end: "bottom top", scrub: true } });
        [".story-intro", "#developers", ".landing-faq"].forEach((selector) => {
          gsap.from(selector, { y: 36,
            ease: "none", scrollTrigger: { trigger: selector, start: "top bottom", end: "top 65%", scrub: true } });
        });
        // Keep the trigger still while its panel expands. Clamp the end to the
        // document bottom so the closing motion remains reachable on short pages.
        const closing = gsap.timeline({ scrollTrigger: { trigger: ".landing-cta-scroll", start: "top 95%", end: "clamp(bottom 60%)", scrub: true } });
        closing.fromTo(".landing-cta", { scale: 0.88, y: 60 }, { scale: 1, y: 0, duration: 1, ease: "none" }, 0)
          .fromTo(".landing-cta-copy h2", { y: 44 }, { y: 0, duration: 0.65, ease: "power2.out" }, 0.1)
          .fromTo(".landing-cta-boundaries span", { x: 120, rotation: 24, scale: 0.9 }, { x: -40, rotation: -12, scale: 1.1, stagger: 0.08, duration: 0.84, ease: "none" }, 0);
      }, root);
      // A single stationary document evolves while the original chapters remain
      // in reading order. The visual duplicate is hidden from assistive technology.
      media.add("(min-width: 1100px) and (min-height: 950px) and (prefers-reduced-motion: no-preference)", () => {
        const sequence = root.current!.querySelector<HTMLElement>(".story-sequence")!;
        sequence.classList.add("is-morphing");
        const states = Array.from(sequence.querySelectorAll<HTMLElement>(".story-morph-state"));
        const chapters = Array.from(sequence.querySelectorAll<HTMLElement>(".story-chapter"));
        gsap.set(states.slice(1), { opacity: 0, y: 28, scale: 0.97 });
        ScrollTrigger.create({ trigger: sequence.querySelector(".story-morph"), start: "top 110px",
          endTrigger: sequence, end: "bottom bottom", pin: true, pinSpacing: false });
        const agentLayer = sequence.querySelector<HTMLElement>(".story-satellite-agent")!;
        const tokenLayer = sequence.querySelector<HTMLElement>(".story-satellite-token")!;
        const agentLabel = agentLayer.querySelector<HTMLElement>(".satellite-label")!;
        const tokenLabel = tokenLayer.querySelector<HTMLElement>(".satellite-label")!;
        const labels = [["YOUR PERMISSION", "PAYMENT REQUEST"], ["AMOUNT LIMIT", "FOR YOUR REVIEW"], ["LINKED PERMISSION", "RECEIPT AMOUNT"], ["YOU KEEP CONTROL", "SPENDING RECORDED"]];
        const timeline = gsap.timeline({ scrollTrigger: {
          trigger: chapters[0], start: "center center", endTrigger: chapters[3], end: "center center", scrub: true,
          onUpdate: self => {
            const index = Math.min(3, Math.round(self.progress * 3));
            agentLabel.textContent = labels[index][0]; tokenLabel.textContent = labels[index][1];
          },
        }});
        states.forEach((state, index) => {
          if (!index) return;
          const position = index - 0.4;
          timeline.to(states[index - 1], { opacity: 0, y: -20, scale: 0.97, duration: 0.4, ease: "power2.inOut" }, position)
            .to(state, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "power2.inOut" }, position);
        });
        timeline.to({}, { duration: 0.4 });
        timeline.to(agentLayer, { x: 8, y: -16, rotation: 0, duration: 3, ease: "none" }, 0)
          .to(tokenLayer, { x: -8, y: 18, rotation: 0, duration: 3, ease: "none" }, 0);
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
    })();

    return () => { disposed = true; media?.revert(); };
  }, [root]);
}
