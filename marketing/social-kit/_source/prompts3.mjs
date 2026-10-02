// Batch 3: more concepts + stories + x402 explainer carousel. Reuses batch-2 builder pieces.
import b2 from "./prompts2.mjs";
const base = b2[0].prompt; // pull shared STYLE/NEG blocks from batch 2 to stay identical
const STYLE = base.slice(base.indexOf("STYLE:"), base.indexOf("REFERENCES:")).trim();
const NEG = base.slice(base.indexOf("CONSTRAINTS:")).trim();
const NAMES = { "x402-official": "the official x402 logo (shield with dollar sign + 'x402' wordmark)", solana: "the official Solana logo (three slanted gradient bars, teal to purple)", usdc: "the official USDC coin logo" };
const refText = (refs) => `REFERENCES: uploaded image 1 is the ChainPay app icon (blue rounded-square tile with a white two-hook link mark). ` +
  refs.map((r, i) => `Uploaded image ${i + 2} is ${NAMES[r]}.`).join(" ") + ` Reproduce every logo EXACTLY as in its reference image; never redesign, recolor, merge or invent logos. Only use the logos listed.`;
const mk = (id, aspect, out, dir, subject, line, comp, refs = []) => ({ id, aspect, out, dir, refs,
  prompt: `TYPE: a social media post for ChainPay, an app that lets AI agents pay with stablecoins on Solana within limits the user sets\nSUBJECT: ${subject}\nCOMPOSITION: ${comp}\nTEXT: the headline reads "${line}" exactly, in deep ink #14213D (white if on solid blue), medium weight.\n${STYLE}\n${refText(refs)}\n${NEG}` });
const SQ = "square; headline large in the bottom third, left-aligned; illustration centered above; generous margins; pale blue #EAF1FF background";
const WIDE = "16:9 landscape; headline left-aligned on the left half, vertically centered; illustration on the right half; white to #EAF1FF soft background";
const STORY = "vertical 9:16 phone story; keep the top 14% and bottom 18% free of important content; headline large in the lower-middle, left-aligned; illustration in the middle; ";
const TALL = (n, of) => `portrait; headline large in the bottom third, left-aligned; illustration centered in the upper 60%; pale blue #EAF1FF background; small ${of}-dot pagination indicator at the very bottom center with dot ${n} filled blue`;

export default [
  // X posts
  mk("x-post-per-call", "16:9", [1600, 900], "x", "the mascot robot next to a soft-3D API endpoint block; a neat stream of tiny chips labelled \"0.002 USDC\" with the USDC logo from image 2 flows from the robot into the block", "Your agent pays per call. Not per month.", WIDE, ["usdc"]),
  mk("x-post-spend-bar", "16:9", [1600, 900], "x", "a soft-3D floating dashboard card showing a single rounded progress bar labelled \"3.20 / 5 USDC\" filled about two thirds in ChainPay blue, with a small ChainPay tile from image 1 on the card; the mascot robot peeks from behind the card", "Agents pay. You watch.", WIDE),
  mk("x-post-gm", "16:9", [1600, 900], "x", "a sunrise made of soft pale-blue and peach gradients behind the mascot robot holding nothing, a small floating receipt with a blue check beside it, a coffee cup with the ChainPay mark from image 1", "gm. Your agent already paid for the data.", WIDE),
  // squares
  mk("square-no-card", "1:1", [1080, 1080], "square", "an empty soft-3D card slot with a dashed outline where a credit card would go, and instead a small blue permission card labelled \"Limit: 5 USDC\" with the ChainPay mark from image 1 sliding in", "No card on file. Just a limit.", SQ),
  mk("square-cap", "1:1", [1080, 1080], "square", "two soft-3D sliders stacked: the first labelled \"Per payment\" set to \"1 USDC\", the second labelled \"Total\" set to \"5 USDC\"; knobs in ChainPay blue", "You set the cap. Per payment and total.", SQ),
  mk("square-expires", "1:1", [1080, 1080], "square", "a soft-3D hourglass with pale-blue sand next to a small blue permission card labelled \"ends Friday\"", "Expires when you say.", SQ),
  mk("square-verify", "1:1", [1080, 1080], "square", "a crisp white receipt card with a ChainPay logo stamp from image 1 and a big blue check badge, a magnifying glass hovering over it, a small share arrow icon in the corner", "Share a receipt. Anyone can verify it.", SQ),
  mk("square-owned", "1:1", [1080, 1080], "square", "a large soft-3D ChainPay tile from image 1 held up on a small pedestal labelled \"yours\", the mascot robot standing beside it at a respectful distance", "Built for agents. Owned by you.", SQ),
  mk("square-meme-habits", "1:1", [1080, 1080], "square", "the mascot robot wearing tiny round glasses, sitting at a mini desk with a neat ledger and a receipt with a blue check; a small chip \"4.80 / 5 USDC\"", "My agent has better spending habits than me.", SQ),
  mk("square-meme-only-2", "1:1", [1080, 1080], "square", "two soft-3D chat bubbles: the robot's bubble says \"it's only 2 USDC\" and a reply bubble with the Solana logo from image 2 says \"no\"; the mascot robot looking sheepish", "Limits are limits.", SQ, ["solana"]),
  mk("square-meme-understood", "1:1", [1080, 1080], "square", "two stacked chat bubbles: top bubble from a user reads \"5 USDC max.\", bottom bubble from the mascot robot reads \"understood.\" with a tiny salute-like blue spark", "Finally, an agent that listens.", SQ),
  mk("square-human-loop", "1:1", [1080, 1080], "square", "a soft-3D phone showing a single approval card with two rounded buttons \"Approve\" (blue) and \"Decline\" (white), the mascot robot waiting patiently beside the phone", "Human in the loop. When you want.", SQ),
  // stories 9:16
  mk("story-rules", "9:16", [1080, 1920], "instagram-story", "a tall soft-3D ChainPay tile from image 1 standing like a monument, the small mascot robot at its base looking up", "Your agent. Your rules.", STORY + "deep ChainPay blue #0052FF gradient background, headline in white"),
  mk("story-paywall", "9:16", [1080, 1920], "instagram-story", "the mascot robot gliding through a glowing translucent blue paywall gate carrying the x402 logo from image 2", "Paywalls are easy now.", STORY + "pale blue #EAF1FF background", ["x402-official"]),
  mk("story-devnet", "9:16", [1080, 1920], "instagram-story", "the mascot robot giving a little hop beside a floating soft-3D button labelled \"Try ChainPay\"", "Try it on devnet.", STORY + "pale blue #EAF1FF background"),
  // x402 explainer carousel
  ...[
    ["the mascot robot knocking on a soft-3D door labelled \"402 Payment Required\" with the x402 logo from image 2 above it", "Your agent asks for data. The API wants payment.", ["x402-official"]],
    ["a soft-3D permission card labelled \"1 USDC per payment · 5 USDC total\" with a blue check scanning over it, ChainPay tile from image 1 beside it", "ChainPay checks your limit first.", []],
    ["a USDC coin from image 2 sliding along a platform made of Solana logo bars from image 3 toward the open door", "It pays in USDC on Solana.", ["usdc", "solana"]],
    ["the door now open with soft light, the mascot robot holding a glowing data cube, and a crisp receipt with ChainPay stamp from image 1 and a blue check floating beside it", "Your agent gets the data. You get the receipt.", []],
  ].map(([s, l, r], i) => mk(`carousel-x402-${i + 1}`, "3:4", [1080, 1350], "instagram-carousel-x402", s, l, TALL(i + 1, 4), r)),
];
