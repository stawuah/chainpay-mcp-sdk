// Lives outside src/pet so the landing can read it without pulling the pet chunk onto every route.
// What the page may know about the pet right now: is he still saying hello, is a
// speech bubble on screen, and which heading is he perched on. Other surfaces (the landing hero clip)
// pause for him. Ruling: _bmad-output/design-council/landing-brand-ruling-2026-10-04.md (B14).
// Markers: `data-pet-greeting` and `data-pet-speaking` on <html>, `data-pet-perched` on
// the heading, plus a `chainpay:pet-state` window event with the full state on every change.

export const PET_STATE_EVENT = "chainpay:pet-state";
export type PetPresence = { greeting: boolean; speaking: boolean; perch: Element | null };

const state: PetPresence = { greeting: false, speaking: false, perch: null };

function announce() {
  // Set once, so a page mounted after his hello knows he is already here.
  document.documentElement.setAttribute("data-pet-ready", "");
  window.dispatchEvent(new CustomEvent<PetPresence>(PET_STATE_EVENT, { detail: { ...state } }));
}

/** True from the moment he arrives until his hello (boot line and greeting) is over. */
export function setPetGreeting(greeting: boolean) {
  if (state.greeting === greeting) return;
  state.greeting = greeting;
  document.documentElement.toggleAttribute("data-pet-greeting", greeting);
  announce();
}

export function setPetSpeaking(speaking: boolean) {
  if (state.speaking === speaking) return;
  state.speaking = speaking;
  document.documentElement.toggleAttribute("data-pet-speaking", speaking);
  announce();
}

export function setPetPerch(perch: Element | null) {
  if (state.perch === perch) return;
  state.perch?.removeAttribute("data-pet-perched");
  state.perch = perch;
  perch?.setAttribute("data-pet-perched", "");
  announce();
}
