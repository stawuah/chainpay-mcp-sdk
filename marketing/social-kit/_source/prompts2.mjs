// Batch 2: capabilities, control, meme, carousel. `refs` = extra official logos (uploaded as images 2..n).
const NAMES = { "x402-official": "the official x402 logo (shield with dollar sign + 'x402' wordmark)", crossmint: "the official Crossmint logo (green four-leaf mark + 'crossmint' wordmark)",
  mcp: "the official Model Context Protocol logo (black interlocking-loop mark + wordmark)", solana: "the official Solana logo (three slanted gradient bars, teal to purple)",
  usdc: "the official USDC coin logo", eurc: "the official EURC coin logo", pyusd: "the official PayPal USD (PYUSD) coin logo", usdg: "the official USDG coin logo" };
const STYLE = `STYLE: modern crypto-app brand marketing in the spirit of Phantom wallet's social posts — clean, confident, playful but not childish. Soft 3D rendered objects with rounded edges, matte and slightly glossy surfaces, gentle studio lighting, soft long shadows. Palette: ChainPay blue #0052FF, deep ink #14213D, white, pale blue tints (#EAF1FF, #C9DBFF). Lots of negative space. Typography: clean geometric sans-serif, medium weight, tight tracking, sentence case.
The recurring mascot (when used) is a friendly minimal white soft-3D robot: rounded egg-shaped body, glossy dark-navy visor with two glowing light-blue dot eyes, no mouth, no arms, no hands.`;
const NEG = `CONSTRAINTS: keep the top-left corner area (about 22% width × 16% height) empty plain background for a logo overlay. Render ONLY the text specified, spelled exactly. No other words, no fake gibberish text, no watermarks, no human faces, no hands, no rocket emojis, no collage.`;
const refText = (refs) => `REFERENCES: uploaded image 1 is the ChainPay app icon (blue rounded-square tile with a white two-hook link mark). ` +
  refs.map((r, i) => `Uploaded image ${i + 2} is ${NAMES[r]}.`).join(" ") +
  ` Reproduce every logo EXACTLY as in its reference image — same shapes, colors, proportions and spelling; never redesign, recolor, merge or invent logos. Only use the logos listed.`;
const mk = (id, aspect, out, dir, subject, line, comp, refs = []) => ({ id, aspect, out, dir, refs,
  prompt: `TYPE: a social media post for ChainPay, an app that lets AI agents pay with stablecoins on Solana within limits the user sets\nSUBJECT: ${subject}\nCOMPOSITION: ${comp}\nTEXT: the headline reads "${line}" exactly, in deep ink #14213D (white if on solid blue), medium weight.\n${STYLE}\n${refText(refs)}\n${NEG}` });
const SQ = "square; headline large in the bottom third, left-aligned; illustration centered above; generous margins; pale blue #EAF1FF background";
const WIDE = "16:9 landscape; headline left-aligned on the left half, vertically centered; illustration on the right half; white to #EAF1FF soft background";
const TALL = "portrait; headline large in the bottom third, left-aligned; illustration centered in the upper 60%; pale blue #EAF1FF background; small 5-dot pagination indicator at the very bottom center with dot NUM filled blue";

const x402 = ["the mascot robot gliding through a glowing translucent blue paywall gate; the gate carries the x402 logo from image 2; a small chip labelled \"0.01 USDC\" with the USDC logo from image 3 floats beside the robot", "Your agent hit a paywall. It paid.", ["x402-official", "usdc"]];
const tokens = ["a 3D ChainPay logo tile from image 1 at center, orbited by exactly four thick 3D coins showing the USDC, EURC, PYUSD and USDG logos from images 2–5", "Dollars, euros, PayPal USD. Your call.", ["usdc", "eurc", "pyusd", "usdg"]];
const shop = (line) => ["the mascot robot carrying a small soft-3D shopping bag; beside it a floating rounded card showing a colorful abstract NFT artwork thumbnail and a chip \"25 USDC max\"; the Crossmint logo from image 2 on the bag", line, ["crossmint"]];

export default [
  mk("x-post-x402", "16:9", [1600, 900], "x", ...x402.slice(0, 2), WIDE, x402[2]),
  mk("square-x402", "1:1", [1080, 1080], "square", ...x402.slice(0, 2), SQ, x402[2]),
  mk("square-mcp", "1:1", [1080, 1080], "square", "a soft-3D chat window; inside, a user chat bubble reads \"Pay for this API. 1 USDC max.\" and a reply bubble shows a blue check; the MCP logo from image 2 sits on a small plug-shaped connector cable linking the chat window to a 3D ChainPay tile from image 1", "Works wherever your agent works.", SQ, ["mcp"]),
  mk("x-post-tokens", "16:9", [1600, 900], "x", ...tokens.slice(0, 2), WIDE, tokens[2]),
  mk("square-tokens", "1:1", [1080, 1080], "square", ...tokens.slice(0, 2), SQ, tokens[2]),
  mk("square-solana", "1:1", [1080, 1080], "square", "a 3D ChainPay tile from image 1 resting on a wide glossy platform made of the Solana logo bars from image 2; a small receipt with a blue check pops out of the tile", "Checked on-chain. Settled on Solana.", SQ, ["solana"]),
  mk("square-crossmint-soon", "1:1", [1080, 1080], "square", ...shop("Your agent's going shopping. Crossmint, soon.").slice(0, 2), SQ, ["crossmint"]),
  mk("square-crossmint-live", "1:1", [1080, 1080], "square", ...shop("Your agent can shop now. Paid on Crossmint.").slice(0, 2), SQ, ["crossmint"]),
  mk("square-pause", "1:1", [1080, 1080], "square", "a giant soft-3D toggle switch in the off position with a pause symbol on the knob; the mascot robot sits beside it looking calm with its eyes as two small horizontal lines (resting)", "Pause anytime. Seriously.", SQ),
  mk("square-modes", "1:1", [1080, 1080], "square", "a large soft-3D segmented switch with two options labelled \"Ask me first\" and \"Autopilot\"; \"Ask me first\" is selected in ChainPay blue; the mascot robot peeks over the switch", "You approve. Or let it ride.", SQ),
  mk("square-revoke", "1:1", [1080, 1080], "square", "a single big glossy rounded button labelled \"Revoke\" in blue being pressed, with a small permission card nearby crumbling into soft pale-blue particles", "Revoke in one tap.", SQ),
  mk("square-meme-lunch", "1:1", [1080, 1080], "square", "the mascot robot looking up hopefully, with a speech bubble reading \"1 USDC?\"; a small 3D ChainPay tile from image 1 beside it like a parent's wallet", "POV: your agent asks for lunch money.", SQ),
  mk("square-meme-card", "1:1", [1080, 1080], "square", "the mascot robot proudly holding up (balanced on its head) a small blue card labelled \"Budget: 5 USDC\" while a generic grey credit card lies far away crossed out", "Gave my agent a budget. Not my card.", SQ),
  mk("square-meme-receipts", "1:1", [1080, 1080], "square", "a tall neat stack of crisp white receipts, each stamped with the ChainPay logo from image 1 in blue, the top one with a blue check", "Receipts or it didn't happen.", SQ),
  ...[
    ["the mascot robot standing in front of floating cards for an API, a dataset and a GPU, each with a small price tag", "Your agent wants to pay for stuff."],
    ["the mascot robot holding nothing; next to it a small blue permission card \"5 USDC · ends Friday\" while a big wallet stays locked behind it with a padlock", "Give it a limit. Not your wallet."],
    ["a chip labelled \"2 USDC\" bouncing off a translucent blue barrier labelled \"1 USDC max\" sitting on a platform of Solana logo bars from image 2", "Solana checks every payment."],
    ["a crisp white receipt floating with a ChainPay logo stamp from image 1 and a blue check, soft glow behind", "Every payment comes with receipts."],
    ["a large soft-3D ChainPay tile from image 1 on a blue gradient, with the mascot robot giving a little hop beside it", "Try it on devnet."],
  ].map(([s, l], i) => mk(`carousel-${i + 1}`, "3:4", [1080, 1350], "instagram-carousel", s, l, TALL.replace("NUM", String(i + 1)), i === 2 ? ["solana"] : [])),
];
