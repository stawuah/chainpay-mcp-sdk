// Seedance 2 Mini loops from finished cards. first_frame = last_frame = the card → seamless loop.
const BASE = `The video starts and ends on exactly the provided frame; it is a seamless loop, so the final second eases every element back to its starting position.
Camera: locked-off, static, no zoom, no pan; 30fps; all motion eased (ease-in-out), gentle and premium.
Render Style: soft Pixar-like 3D product render matching the frame exactly; matte-gloss plastic and frosted glass materials; studio HDRI lighting with soft contact shadows.
Typography and logos: all text, the headline, the top-left ChainPay logo and wordmark, and every logo stay perfectly still, crisp and unchanged for the whole clip. Do not move, redraw, morph or re-letter any text or logo.
Color and exposure: keep the exact background color, white balance and brightness of the provided frame for every frame; no color grading change, no darkening, no desaturation.
Logo tiles: any 3D ChainPay logo tile never rotates, flips or turns; it may only hover a few pixels while a soft light glint sweeps across its surface. The white two-hook mark on it never changes shape or mirrors.
Color Palette: ChainPay blue #0052FF, ink #14213D, white, pale blue #EAF1FF. No new colors, no new objects, no people, no hands, no camera shake, no flicker, no scene cut.
Duration: 5 seconds.`;
const m = (id, src, hook, motion) => ({ id, src, prompt: `${hook}\nMotion/Animation: ${motion}\n${BASE}` });
export default [
  m("allowance", "x/x-post-allowance.png", "A cheerful robot agent comes alive beside its new allowance card.",
    "the white robot bobs gently up and down (about 3% of its height) and blinks its two blue dot eyes once; the small \"5 USDC\" card floats with a slow 3° tilt sway; the 3D ChainPay tile stays in place, hovering 1–2%, with a soft specular glint sweeping across it"),
  m("nope", "x/x-post-nope.png", "A 2 USDC chip tries to get through a 1 USDC limit and bounces right off.",
    "the blue chip (its printed label stays exactly \"2 USDC\", never re-lettered) flies toward the translucent barrier, taps it, a soft ripple spreads across the frosted glass, and the chip arcs back to its starting spot; the barrier gives a tiny wobble then settles"),
  m("x402", "x/x-post-x402.png", "A small white egg-shaped mascot slips through a glowing glass gate.",
    "the mascot drifts slightly forward into the gate and back while the gate's blue glow pulses softly once; light streaks shimmer across the gate surface; the \"0.01 USDC\" chip floats and rotates slightly"),
  m("tokens", "x/x-post-tokens.png", "Four stablecoins orbit the ChainPay tile.",
    "the four coins drift along their orbit ring a short distance and return, each coin rotating slightly on its axis with specular highlights sliding over the rims; the ChainPay tile hovers with a gentle 2% bob; the small robot peeks and blinks"),
  m("receipts", "x/x-post-receipts.png", "A fresh receipt floats in, stamped and checked.",
    "the paper receipt floats up and down slowly with a slight paper flutter at its curled edge; the blue check mark pulses once with a soft glow; tiny pale-blue sparkles drift and fade near the stamp"),
  m("pause", "square/square-pause.png", "One satisfying toggle, rendered like a soft toy.",
    "the blue toggle knob presses down with a soft squish and springs back; the small white egg-shaped mascot beside it blinks its resting line-eyes and sways slightly side to side, calm"),
  m("meme-lunch", "square/square-meme-lunch.png", "The robot asks for lunch money, very politely.",
    "the robot tilts its head slightly and gives a small hopeful hop, eyes blinking; the \"1 USDC?\" speech bubble is visible in every frame from the very first frame, it only pulses gently (100% to 104% and back), its text unchanged; the ChainPay tile stays steady with a soft glint"),
  m("x-header", "../motion/x-header-21x9.png", "A floating ChainPay tile hovers in calm blue space.",
    "the big 3D ChainPay tile floats with a slow 2% bob (no rotation or tilt), a soft specular glint sweeping across its surface; the blurred pale shapes in the background drift very slowly for parallax"),
  m("modes", "square/square-modes.png", "A soft segmented switch flips between two modes and back.",
    "the blue highlight pill slides smoothly from \"Ask me first\" toward \"Autopilot\" and back again, both labels staying perfectly legible and unchanged; the small white egg-shaped mascot peeking over the switch blinks once"),
  m("verify", "square/square-verify.png", "A receipt gets checked under a magnifying glass.",
    "the magnifying glass glides slowly across the receipt and back with a soft lens refraction; the blue check badge pulses once with a gentle glow; the receipt floats slightly"),
  m("meme-habits", "square/square-meme-habits.png", "A tiny mascot accountant reviews its own spending, very pleased.",
    "the small white mascot with round glasses nods slowly once as if reading, its blue eyes blinking; the receipt on the desk flutters slightly; the \"4.80 / 5\" chip floats a few pixels up and down; the potted plant leaves sway gently"),
];
