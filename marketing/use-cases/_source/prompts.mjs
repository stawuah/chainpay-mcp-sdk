// One entry per use case image. Style is locked in _bmad-output/design-council/use-cases-ruling-2026-10-03.md (U9, U10).
const STYLE = `STYLE: premium product illustration for a crypto payments app, in the same look as the reference images — soft 3D rendered objects with rounded edges, matte and slightly glossy surfaces, gentle studio lighting from the upper left, soft long shadows. Palette strictly: ChainPay blue #0052FF, deep ink #14213D, white, pale blue #EAF1FF and #C9DBFF. Plain pale blue #EAF1FF background, seamless, no horizon line. Lots of negative space; subject centered with about 15% margin on every side so it survives a 4:3 crop.
LOGO: if the ChainPay logo appears, copy image 1 exactly (blue rounded-square tile, white two-hook mark). Do not redesign it.`;
const ROBOT = `ROBOT: copy the robot from image 2 exactly — white soft-3D body, navy visor, two blue dot eyes, no arms, no mouth. Ignore every word in image 2.`;
const NEG = `CONSTRAINTS: no headline text. Render only the labels specified, spelled exactly; otherwise no words, no fake UI text, no numbers. No people, no hands, no faces, no coins with dollar signs, no rockets, no sparkles, no collage, no watermark. Never place a logo, badge or lockup in a corner of the frame.`;

const p = (subject, robot) => `SUBJECT: ${subject}\n${STYLE}\n${robot ? ROBOT + "\n" : ""}${NEG}`;
const a = (id, subject, robot = false) => ({ id, aspect: "4:3", robot, prompt: p(subject, robot) });

export default [
  a("sponsor-funds-agent", "a white soft-3D gift box with a ChainPay blue ribbon, lid lifted, releasing a glossy blue allowance chip labelled \"500 USDC\" that floats toward the small robot standing to the right; the robot looks up at it. Wide, calm composition", true),
  a("pay-per-api-call", "a row of three small rounded white tiles like API endpoints, each with a tiny blue chip labelled \"0.01 USDC\" clicking into a slot on its side; a thin glowing blue line connects them left to right"),
  a("research-agent-buys-data", "a stack of three soft-3D white report folders with blue tabs; the small robot sits beside them holding nothing (it has no arms), a small blue chip labelled \"2 USDC\" resting on the top folder", true),
  a("buy-tools-from-catalog", "a neat soft-3D shelf with four rounded tool boxes in white and blue, one box pulled slightly forward with a small blue price tag chip labelled \"5 USDC\""),
  a("pay-from-your-ai-app", "a rounded white chat window floating at a slight angle, with one blue message bubble (no text) and below it a small white approval card with a blue check mark and the ChainPay logo tile from image 1"),
  a("team-agent-allowance", "a soft-3D white card like a calendar week strip with seven small rounded cells, a blue progress fill covering three of them, and a floating blue chip labelled \"25 USDC · ends Friday\"; the small robot peeks from behind the card's right edge", true),
  a("receipts-for-accounting", "a crisp white paper receipt floating at a slight angle with clean grey placeholder lines, stamped at the bottom with the ChainPay logo from image 1 like an ink stamp, next to a small open blue ledger book"),
  a("invoices-matched-to-payments", "two white paper cards side by side — an invoice with grey lines and a receipt with grey lines — joined by a glowing blue link between them and a small blue check badge where they meet"),
  a("approve-big-buys", "a large soft-3D blue approval button on a white rounded base, with a small white toggle beside it switched to the left; a gentle highlight on the button"),
  a("one-tap-stop", "a chunky soft-3D white toggle switch with a blue pause symbol on the knob, switched off; a few small blue chips resting still beside it as if frozen mid-motion"),
  a("spend-overview-anywhere", "a white rounded dashboard panel with a soft blue bar chart of five bars and one thin spend-limit line across them, tilted slightly, floating above a second smaller panel"),
  a("get-paid-by-agents", "a white soft-3D shop door with a small blue sign labelled \"402\" on it, slightly open with blue light coming through; the small robot waits politely in front of it", true),
  a("purchase-order-link", "a white envelope opened at an angle with a blue link chain icon card sliding out of it, the card shows a small blue chip labelled \"PO\""),
  a("prove-you-delivered", "a white rounded parcel box with a blue seal on top that has a check mark, next to a small white certificate card with a blue ribbon"),
  a("agent-shopping-checkout", "a soft-3D white shopping bag with the ChainPay logo tile from image 1 on it, beside a small white product card with a blue price chip; the small robot stands behind the bag, only its head visible", true),
];
