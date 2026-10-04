// Cards area in a real browser, through the dashboard harness (?tab=cards):
// illustrative fixtures behind the same CardsSource interface, no wallet, no
// backend, every non-local request aborted. Covers the PR #40 review fixes:
// card number closes (F7), unknown repayment outcome (F4/X2), restore refusal
// (F1/X4), failed private reads (F9), privacy copy (F6), approver attestation
// (X5), and no horizontal overflow at 390px.
// Set CARDS_SHOTS_DIR to save a screenshot of each view.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BASE_URL, launchBrowser } from "./browser/_helpers.mjs";

const SHOTS = process.env.CARDS_SHOTS_DIR || "";
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const HARNESS = `${BASE_URL}/test/fixtures/dashboard-harness.html?tab=cards`;

const browser = await launchBrowser();
const errors = [];
const external = new Set();

async function open(query, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 } });
  page.on("pageerror", (error) => errors.push(`${query}: ${error.message}`));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE_URL)) return route.continue();
    external.add(new URL(url).host);
    return route.abort();
  });
  await page.goto(`${HARNESS}${query}`);
  await page.locator(".cp-cards").waitFor();
  await page.waitForTimeout(700);
  return page;
}

async function shot(page, name, focus) {
  if (!SHOTS) return;
  if (focus) await page.locator(focus).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  // A dialog scrolls inside itself: capture the viewport, not the page behind it.
  const dialog = await page.getByRole("dialog").count();
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: !dialog });
}

async function noOverflow(page, label) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(scroll <= inner, `${label}: horizontal overflow (${scroll} > ${inner})`);
}

const revealState = (page) => page.locator(".cp-card-number-reveal").getAttribute("data-state");

// F6: the list and the unlock strip carry the one accurate privacy sentence.
{
  const page = await open("&cards=locked");
  const text = await page.locator("main, body").first().innerText();
  assert.doesNotMatch(text, /Only you see its limits|only you can read|Nobody else|Only your wallet and people you add/i);
  assert.match(await page.getByTestId("cards-unlock").innerText(), /ChainPay's approver, readers you add and the card issuer can see them/);
  await shot(page, "list-locked-1440");
  await page.close();
}

// F7: the card number frame closes on a section switch and when the tab is hidden.
{
  const page = await open("&card=data");
  await page.getByRole("button", { name: "Show card number" }).click();
  await page.waitForTimeout(300);
  assert.equal(await revealState(page), "open");
  await shot(page, "reveal-open-1440");
  await page.getByRole("tab", { name: "Statement" }).click();
  await page.waitForTimeout(300);
  assert.equal(await revealState(page), "closed", "section switch closes the card number");
  await page.getByRole("button", { name: "Show card number" }).click();
  await page.waitForTimeout(300);
  assert.equal(await revealState(page), "open");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  assert.equal(await revealState(page), "closed", "hidden tab closes the card number");
  await shot(page, "reveal-closed-after-switch-1440");
  await page.close();
}

// F4/X2: an unknown repayment outcome never reads "Not paid", and Pay stays off.
{
  const page = await open("&card=data&section=statement&repay=unknown");
  await page.getByTestId("card-statement").getByRole("button", { name: /^Pay \$/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("repayment-dialog").waitFor();
  const pay = dialog.getByRole("button", { name: /^Pay \$/ });
  await page.waitForFunction(() => !document.querySelector('[data-testid="repay-checking"]'));
  assert.equal(await pay.isEnabled(), true, "payable before any attempt");
  await pay.click();
  await dialog.getByTestId("repay-unknown").waitFor();
  assert.match(await dialog.getByTestId("repay-unknown").innerText(), /Outcome unknown — checking/);
  assert.doesNotMatch(await dialog.innerText(), /Not paid/);
  assert.equal(await pay.isEnabled(), false, "Pay disabled while the outcome is unknown");
  await shot(page, "repay-unknown-1440", '[data-testid="repay-unknown"]');
  await page.close();
}

// F1/X4: a restore that changes rules the owner didn't review is refused in the browser.
{
  const page = await open("&card=travel&restore=tampered");
  await page.getByRole("button", { name: "Review and restore" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("recovery-report").waitFor();
  await dialog.getByRole("button", { name: "Approve restore" }).click();
  const alert = dialog.getByRole("alert");
  await alert.waitFor();
  const message = await alert.innerText();
  assert.match(message, /Not restored/);
  assert.match(message, /max per purchase, shops, fee/);
  assert.equal(await page.getByTestId("recovery-banner").getAttribute("data-recovery"), "recovery_frozen", "nothing was restored");
  await shot(page, "restore-refused-1440", '[data-testid="recovery-report"] [role="alert"]');
  await page.close();
  // The honest co-signed restore passes the same guard.
  const ok = await open("&card=travel");
  await ok.getByRole("button", { name: "Review and restore" }).click();
  await ok.getByRole("dialog").getByRole("button", { name: "Approve restore" }).click();
  await ok.waitForFunction(() => document.querySelector('[data-testid="recovery-banner"]')?.getAttribute("data-recovery") === "restored_pending_reconcile");
  await ok.close();
}

// F9: a failed private read is an error with a retry, never "Private".
{
  const page = await open("&reads=unreadable");
  await page.getByTestId("cards-read-failed").waitFor();
  assert.match(await page.getByTestId("cards-table").innerText(), /Couldn't load/);
  await shot(page, "reads-failed-1440");
  await page.close();
}

// X5: the privacy check shows ChainPay's approver attestation with its real mode.
{
  const page = await open("&card=data&section=privacy&attest=challenge_bound");
  await page.getByRole("button", { name: "Run the check" }).click();
  await page.getByTestId("attestation").waitFor();
  assert.doesNotMatch(await page.getByTestId("attestation").innerText(), /paused|Hardware verified/);
  assert.match(await page.getByTestId("approver-attestation").innerText(), /Report only/);
  await shot(page, "privacy-1440");
  await page.close();
}

// 390px: no horizontal overflow on any cards view, including the new states.
for (const [name, query, act] of [
  ["list-390", "", null],
  ["detail-390", "&card=data", null],
  ["statement-unknown-390", "&card=data&section=statement&repay=unknown", async (page) => {
    await page.getByTestId("card-statement").getByRole("button", { name: /^Pay \$/ }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="repay-checking"]'));
    await page.getByRole("dialog").getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByTestId("repay-unknown").waitFor();
  }],
  ["restore-refused-390", "&card=travel&restore=tampered", async (page) => {
    await page.getByRole("button", { name: "Review and restore" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve restore" }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
  }],
  ["reads-failed-390", "&reads=unreadable", null],
  ["privacy-390", "&card=data&section=privacy", async (page) => {
    await page.getByRole("button", { name: "Run the check" }).click();
    await page.getByTestId("approver-attestation").waitFor();
  }],
]) {
  const page = await open(query, 390);
  if (act) await act(page);
  await noOverflow(page, name);
  await shot(page, name, name.startsWith("statement") ? '[data-testid="repay-unknown"]' : name.startsWith("restore") ? '[data-testid="recovery-report"] [role="alert"]' : undefined);
  await page.close();
}

assert.deepEqual(errors, []);
await browser.close();
console.log(`PASS: cards browser suite (reveal closes, unknown outcome, restore refusal, failed reads, privacy copy, approver attestation, 390px). Blocked external hosts: ${[...external].sort().join(", ") || "none"}.`);
