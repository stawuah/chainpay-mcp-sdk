// One entry per deliverable. `line` is rendered by GPT Image; the exact logo lockup is composited after.
const STYLE = `STYLE: modern crypto-app brand marketing in the spirit of Phantom wallet's social posts — clean, confident, playful but not childish. Soft 3D rendered objects with rounded edges, matte and slightly glossy surfaces, gentle studio lighting, soft long shadows. Palette strictly: ChainPay blue #0052FF, deep ink #14213D, white, pale blue tints (#EAF1FF, #C9DBFF); tiny accents of USDC blue allowed. Lots of negative space. Typography: clean geometric sans-serif (Inter-like), medium weight, tight tracking, sentence case.
REFERENCES: uploaded image 1 is the ChainPay app icon (blue rounded-square tile with a white two-hook "S"/link mark). Whenever the logo appears, copy it exactly: same two rounded hooks rotated 180° from each other, same negative space, same blue. Do not redesign, add strokes, gradients inside the mark, or extra letters.`;
const NEG = `CONSTRAINTS: keep the top-left corner area (about 22% width × 16% height) empty plain background for a logo overlay. Render ONLY the text specified, spelled exactly. No other words, no fake UI gibberish text, no watermarks, no signatures, no people's faces, no hands, no coins with dollar signs, no rocket emojis, no collage.`;
const t = (type, subject, line, comp) =>
  `TYPE: ${type}\nSUBJECT: ${subject}\nCOMPOSITION: ${comp}\nTEXT: the headline reads "${line}" exactly, in deep ink #14213D (or white if on blue), medium weight.\n${STYLE}\n${NEG}`;

const C = {
  allowance: ["a social post card for an AI-agent payments app",
    "a friendly minimal rounded robot-ish agent token (simple pill-shaped head, two dot eyes, no mouth) with a small white card floating beside it labelled \"5 USDC · ends Friday\"; next to it a 3D ChainPay logo tile from image 1",
    "Your agent's got an allowance now."],
  keys: ["a social post card for an AI-agent payments app",
    "a chunky soft-3D wallet with a small padlock, sitting safely; a friendly minimal pill-shaped agent token peeks from outside the wallet, a ChainPay logo tile from image 1 on the wallet clasp",
    "Your agent spends. You hold the keys."],
  nope: ["a social post card for an AI-agent payments app",
    "a small chip labelled \"2 USDC\" bouncing off a translucent rounded blue barrier labelled \"1 USDC max\", with a little motion arc showing the bounce; ChainPay logo tile from image 1 subtly embossed on the barrier",
    "Over the limit? Solana says no."],
  receipts: ["a social post card for an AI-agent payments app",
    "a crisp white paper receipt floating at a slight angle, a few clean grey placeholder lines (no readable text besides the stamp), stamped at the bottom with the ChainPay logo from image 1 in blue like an ink stamp, and a small check mark",
    "Every payment comes with receipts."],
  flow: ["a social post card for an AI-agent payments app",
    "exactly four rounded pill-shaped 3D chips in a gentle horizontal arc connected by thin arrows, labelled in order: \"You set it\", \"Agent asks\", \"Solana checks\", \"Receipt\"; the last chip is solid ChainPay blue with white text",
    "Set it once. Let it run."],
  rails: ["a social post card for an AI-agent payments app",
    "a 3D ChainPay logo tile from image 1 at center with three soft curved rails connecting it to three round token chips labelled \"USDC\", \"EURC\", \"USDG\"",
    "One agent. More ways to pay."],
};

const hero = (comp) => t("a wide social media banner for an AI-agent payments app",
  "a large soft-3D ChainPay logo tile from image 1 floating on a smooth blue gradient (#0052FF to #3B7BFF) with a few out-of-focus rounded pale-blue shapes for depth",
  "Payments for agents. Controlled by you.", comp);

const post = (k, comp) => t(C[k][0], C[k][1], C[k][2], comp);
const SQ = "square 1:1; headline large at the bottom third, left-aligned; illustration centered above; generous margins; pale blue #EAF1FF background";
const WIDE = "16:9 landscape; headline left-aligned on the left half, vertically centered; illustration on the right half; white to #EAF1FF soft background";

export default [
  { id: "x-header",  aspect: "21:9", out: [1500, 500],  dir: "x",        prompt: hero("ultra-wide banner; ALL important content inside the central horizontal band (middle 55% of height); logo tile right of center, headline in white on the left-center; bottom-left area kept empty for a profile picture overlap") },
  { id: "fb-cover",  aspect: "21:9", out: [1640, 624],  dir: "facebook", prompt: hero("ultra-wide banner; all important content within the central 60% width and central 60% height; headline in white left of the logo tile") },
  { id: "reddit-banner", aspect: "21:9", out: [1920, 384], dir: "reddit", prompt: hero("ultra-wide very thin banner; ALL content strictly inside the middle 35% of the height; logo tile small at right-center, headline in white single line at left-center") },
  { id: "x-post-allowance", aspect: "16:9", out: [1600, 900], dir: "x", prompt: post("allowance", WIDE) },
  { id: "x-post-nope",      aspect: "16:9", out: [1600, 900], dir: "x", prompt: post("nope", WIDE) },
  { id: "x-post-receipts",  aspect: "16:9", out: [1600, 900], dir: "x", prompt: post("receipts", WIDE) },
  { id: "fb-post-keys",     aspect: "16:9", out: [1200, 630], dir: "facebook", prompt: post("keys", WIDE + "; keep everything within central 90% height") },
  { id: "fb-post-flow",     aspect: "16:9", out: [1200, 630], dir: "facebook", prompt: post("flow", "16:9 landscape; headline centered at top third; four chips across the lower half; white to #EAF1FF background; keep everything within central 90% height") },
  ...["allowance", "keys", "nope", "receipts", "flow", "rails"].map(k => ({
    id: `square-${k}`, aspect: "1:1", out: [1080, 1080], dir: "square", prompt: post(k, SQ) })),
];
