// Owner workspace acceptance (EXPERIENCE.md, 2026-10-04) in the design harness:
// every tab × {1440, 768, 390} × {populated, empty, unavailable metadata}, plus
// failed collections, signed-out, multi-token, verified-clear and revoked views,
// keyboard order, panel focus restoration, real 200% zoom and reduced motion.
// No wallet, no backend; external requests are blocked and fixture data is not
// payment evidence.
//
// WORKSPACE_ONLY=matrix,zoom,… runs only the named sections (for local iteration).
// WORKSPACE_PROBE_CSS="<css>" injects CSS after every page load, to prove a guard
// fails on a reintroduced defect (mutation probe). Never set in CI.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { BASE_URL, blockExternal, launchBrowser } from "./browser/_helpers.mjs";

const SHOTS = process.env.CHAINPAY_WORKSPACE_SHOTS || "/tmp/chainpay-workspace-shots";
await mkdir(SHOTS, { recursive: true });
const ONLY = process.env.WORKSPACE_ONLY ? new Set(process.env.WORKSPACE_ONLY.split(",")) : null;
const run = (name) => !ONLY || ONLY.has(name);

const TABS = ["overview", "agents", "mandates", "cards", "assistant", "payments", "settings"];
const WIDTHS = [1440, 768, 390];
const POPULATED = "signed-in=fixture&decimals=fixture&inbox=fixture&slot=fixture&receipts";
const STATES = {
  populated: POPULATED,
  // `empty` also empties the Requests inbox (the store outlives a page load).
  empty: "empty=1&signed-in=fixture&decimals=fixture",
  // Every list populated, every token's metadata unavailable — Payments included.
  unavailable: "signed-in=fixture&inbox=fixture&slot=fixture&receipts&decimals=unavailable",
};
const harness = (query) => `${BASE_URL}/test/fixtures/dashboard-harness.html?${query}`;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await blockExternal(page);

const PROBE_CSS = process.env.WORKSPACE_PROBE_CSS || "";

async function open(query, target = page) {
  await target.goto(harness(query));
  await target.locator("h1").first().waitFor();
  // Let metadata, fixture sessions and fixture reads settle.
  await target.waitForFunction(() => !document.querySelector(".dashboard-app [aria-busy='true'] .cp-amount-skeleton, .cp-collection-state.is-loading"), null, { timeout: 8000 }).catch(() => {});
  if (PROBE_CSS) await target.addStyleTag({ content: PROBE_CSS });
  await target.waitForTimeout(250);
}

async function noOverflow(label, target = page) {
  const overflow = await target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: horizontal overflow ${overflow}px`);
}

/** Visible interactive controls in the workspace, Cards included, that are shorter than 44px. */
async function shortControls(target = page) {
  return target.evaluate(() => {
    const selector = "button, [role='tab'], [role='radio'], select, summary, a.astryx-button, input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='file'])";
    return [...document.querySelectorAll(`.dashboard-app ${selector.split(", ").join(", .dashboard-app ")}`)]
      .map((el) => ({ el, box: el.getBoundingClientRect(), style: getComputedStyle(el) }))
      .filter(({ el, box, style }) => box.width > 4 && box.height > 0 && style.visibility !== "hidden" && el.offsetParent !== null)
      // The rendered box is what a finger hits: no exemption for a min-height that may not apply (inline boxes ignore it).
      .filter(({ box }) => box.height < 43.5)
      .map(({ el, box }) => `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => !/^x[0-9a-z]{5,8}$/.test(c)).slice(0, 3).join(".")} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(box.height)}px`);
  });
}

/**
 * Clipped content in the page body:
 * - a control, status or amount cut by a clipping ancestor, hidden in a
 *   horizontal scroller, or pushed past the viewport edge;
 * - text cut off by its own box (overflow hidden/clip, ellipsis included);
 * - a word broken across lines ("Expir/es", "purchas/e").
 * Protocol strings (addresses, hashes, code) may wrap anywhere and are skipped
 * by the word check only.
 */
async function clipped(target = page) {
  return target.evaluate(() => {
    const root = document.querySelector(".dashboard-page");
    if (!root) return ["no .dashboard-page"];
    const viewport = document.documentElement.clientWidth;
    const name = (el) => `${el.tagName.toLowerCase()}${[...el.classList].filter((c) => !/^x[0-9a-z]{5,8}$/.test(c)).slice(0, 2).map((c) => `.${c}`).join("")} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)}"`;
    const shown = (el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 1 && box.height > 1 && style.visibility !== "hidden" && (el.offsetParent !== null || style.position === "fixed");
    };
    const hidden = (el) => el.closest(".sr-only, [aria-hidden='true'], [hidden], dialog:not([open])");
    const problems = [];

    for (const el of root.querySelectorAll("button, a, summary, input, select, [role='radio'], [role='tab'], .cp-status, .cp-amount")) {
      if (!shown(el) || hidden(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.left < -0.5 || box.right > viewport + 0.5) { problems.push(`${name(el)} past the viewport edge`); continue; }
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const scrolls = ["auto", "scroll"].includes(style.overflowX);
        const clips = ["hidden", "clip"].includes(style.overflowX) || ["hidden", "clip"].includes(style.overflowY);
        if (!scrolls && !clips) continue;
        const bounds = parent.getBoundingClientRect();
        if (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5) {
          problems.push(`${name(el)} ${scrolls ? "hidden in a horizontal scroller" : "clipped"} by ${name(parent)}`);
          break;
        }
        if (["hidden", "clip"].includes(style.overflowY) && (box.top < bounds.top - 0.5 || box.bottom > bounds.bottom + 0.5)) {
          problems.push(`${name(el)} clipped vertically by ${name(parent)}`);
          break;
        }
      }
    }

    for (const el of root.querySelectorAll("*")) {
      if (!shown(el) || hidden(el)) continue;
      const style = getComputedStyle(el);
      const clipsX = ["hidden", "clip"].includes(style.overflowX);
      if (!clipsX && style.textOverflow !== "ellipsis") continue;
      if (![...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      if (el.scrollWidth > el.clientWidth + 1) problems.push(`${name(el)} text cut off (${el.scrollWidth} > ${el.clientWidth})`);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent.trim() || !shown(parent) || hidden(parent)) continue;
      // Text past the viewport edge, or past the side of a box that clips or scrolls it.
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      if (text.width > 0) {
        if (text.left < -0.5 || text.right > viewport + 0.5) problems.push(`text past the viewport edge in ${name(parent)}`);
        else for (let box = parent; box && box !== document.body; box = box.parentElement) {
          const style = getComputedStyle(box);
          if (style.overflowX === "visible") continue;
          const bounds = box.getBoundingClientRect();
          if (text.left < bounds.left - 0.5 || text.right > bounds.right + 0.5) { problems.push(`text ${["auto", "scroll"].includes(style.overflowX) ? "hidden in a horizontal scroller" : "clipped"} in ${name(parent)} by ${name(box)}`); break; }
        }
      }
      if (parent.closest("code, pre, .mono, .cp-amount-raw")) continue;
      const pattern = /[A-Za-z][a-z’']{3,}/g;
      for (let match = pattern.exec(node.textContent); match; match = pattern.exec(node.textContent)) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
        if (tops.size > 1) problems.push(`"${match[0]}" broken across lines in ${name(parent)}`);
      }
    }
    return [...new Set(problems)].slice(0, 12);
  });
}

async function assertClean(label, target = page) {
  await noOverflow(label, target);
  assert.deepEqual(await clipped(target), [], `${label}: clipped controls or text`);
  assert.deepEqual(await shortControls(target), [], `${label}: controls under 44px`);
}

/** "Nothing needs your attention" never shares the page with a status that needs the owner. */
async function assertClearIsClear(label, target = page) {
  if (await target.locator(".cp-overview-clear[data-state='clear']").count() === 0) return;
  const alarming = await target.locator(".dashboard-page .cp-status").evaluateAll((els) => els.filter((el) => ["warning", "critical"].includes(el.dataset.tone)).map((el) => el.textContent.trim()));
  assert.deepEqual(alarming, [], `${label}: all-clear shown beside ${alarming.join(", ")}`);
}

/** Unchecked inputs: the sentence keeps its own column beside the pills, or sits wholly below them; never wraps back under a pill. */
async function assertCheckNotes(label, target = page) {
  const notes = await target.locator(".cp-check-note").evaluateAll((els) => els.map((el) => {
    const pills = el.querySelector(".cp-check-note-pills")?.getBoundingClientRect();
    const text = el.querySelector(".cp-check-note-text");
    if (!pills || !text) return { ok: false, why: "no pill or text column" };
    const lines = [...text.getClientRects()];
    const box = text.getBoundingClientRect();
    const beside = box.left >= pills.right - 0.5;
    const below = box.top >= pills.bottom - 0.5;
    return { ok: (beside || below) && lines.length >= 1, why: `text ${Math.round(box.left)},${Math.round(box.top)} vs pills right ${Math.round(pills.right)} bottom ${Math.round(pills.bottom)}` };
  }));
  for (const note of notes) assert.ok(note.ok, `${label}: "not checked" sentence wraps under its pill (${note.why})`);
}

/** The Requests count in the sidebar, the Overview tile and the Requests tab agree. */
async function requestCounts() {
  const badge = await page.locator(".dashboard-sidebar .tool-count").allInnerTexts();
  const tile = (await page.locator(".cp-count").filter({ hasText: "Open requests" }).locator(".cp-count-value").innerText()).trim();
  return { badge: badge.join(""), tile };
}

const sections = [];
const section = (name, fn) => sections.push([name, fn]);

// 1. Every tab × width × state.
section("matrix", async () => {
  for (const [state, query] of Object.entries(STATES)) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      const titleTops = new Map();
      for (const tab of TABS) {
        await open(`tab=${tab}&${query}`);
        const label = `${tab} ${state} ${width}`;
        const h1 = page.locator("h1").first();
        assert.equal(await h1.evaluate((el) => getComputedStyle(el).fontSize), "28px", `${label}: page title 28px`);
        // The page title starts at the content edge on every tab and width, and sits at one height.
        const heading = await page.locator(".dashboard-page .dashboard-heading").first().evaluate((el) => {
          const title = el.querySelector("h1").getBoundingClientRect();
          return { offset: title.left - el.getBoundingClientRect().left, top: Math.round(title.top) };
        });
        assert.ok(Math.abs(heading.offset) <= 1, `${label}: page title starts at the content edge (offset ${heading.offset}px)`);
        titleTops.set(tab, heading.top);
        await assertClean(label);
        const text = await page.locator(".dashboard-page").innerText();
        assert.doesNotMatch(text, /\bbase units\b/, `${label}: unformatted base units shown as an amount`);
        assert.equal(await page.locator(".cp-usage-ring").count(), tab === "overview" && state !== "empty" ? 1 : 0, `${label}: exactly one usage ring, on Overview`);
        // Visually hidden text never renders as visible copy.
        const leakedSrText = await page.locator(".dashboard-page .sr-only, .dashboard-page [class*='sr-only']").evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width > 1).map((el) => el.textContent));
        assert.deepEqual(leakedSrText, [], `${label}: screen-reader text is visible`);
        // Every raw-units disclosure looks like one: its chevron is rendered, not merely present.
        const rawSummaries = await page.locator(".cp-amount-raw > summary").evaluateAll((els) => els.filter((el) => el.offsetParent).map((el) => {
          const cue = el.querySelector("svg");
          if (!cue) return false;
          const box = cue.getBoundingClientRect();
          const style = getComputedStyle(cue);
          return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && parseFloat(style.opacity) > 0;
        }));
        assert.ok(rawSummaries.every(Boolean), `${label}: a raw-units disclosure has no visible disclosure cue`);
        if (tab === "overview") await assertClearIsClear(label);
        if (tab === "assistant") {
          // One row of request tabs at every width; every tab keeps a 44px target (shortControls) and a name.
          const tabs = await page.locator(".owner-inbox [role='tab']").evaluateAll((els) => els.map((el) => ({ top: Math.round(el.getBoundingClientRect().top), name: el.textContent.trim() })));
          assert.equal(tabs.length, 4, `${label}: four request tabs`);
          assert.equal(new Set(tabs.map((tab) => tab.top)).size, 1, `${label}: request tabs on one row (${tabs.map((tab) => `${tab.name}@${tab.top}`).join(", ")})`);
          assert.ok(tabs.every((tab) => tab.name.length > 0), `${label}: every request tab is named`);
          // At 390 and up all four fit: the strip neither scrolls nor fades a tab out.
          const strip = await page.locator(".owner-inbox [role='tablist']").evaluate((el) => ({ hidden: el.scrollWidth - el.clientWidth, mask: getComputedStyle(el).maskImage }));
          assert.ok(strip.hidden <= 1 && strip.mask === "none", `${label}: request tabs scroll or fade (${strip.hidden}px hidden, mask ${strip.mask})`);
        }
        if (state === "unavailable" && tab === "overview") {
          assert.match(text, /Amounts? unavailable/, `${label}: unavailable metadata says so`);
          assert.equal(await page.locator(".cp-usage-ring.is-unavailable").count(), 1, `${label}: dashed ring without a percentage`);
          assert.doesNotMatch(await page.locator(".cp-usage-ring").innerText(), /\d/, `${label}: no percentage when metadata is unavailable`);
          assert.equal(await page.locator(".cp-overview-spending .cp-amount-raw").count(), 1, `${label}: one grouped raw-units disclosure for the spending figures`);
        }
        if (state === "unavailable" && tab === "mandates") assert.match(text, /Amounts unavailable/, `${label}: ledger hides amounts`);
        if (state === "unavailable" && tab === "payments") {
          assert.match(text, /Amount unavailable/, `${label}: payment amounts say they are unavailable`);
          assert.doesNotMatch(text, /4\.50000\d/, `${label}: no amount formatted without verified decimals`);
          assert.doesNotMatch(text, /Payment history is unavailable/, `${label}: history loaded; only token details are missing`);
        }
        if (state === "empty" && tab === "assistant") {
          assert.match(text, /Nothing in this browser needs your approval/, `${label}: Requests is empty`);
          assert.doesNotMatch(text, /Market data API/, `${label}: no request left over from another fixture`);
        }
        if (state === "empty" && tab === "overview") {
          assert.doesNotMatch(text, /\bmandate\b/i, `${label}: owner copy says permission, not mandate`);
        }
        if (state === "empty" && tab === "mandates") {
          assert.equal(await page.getByRole("button", { name: "New permission", exact: true }).count(), 1, `${label}: one New permission action`);
          assert.equal(await page.getByRole("radiogroup", { name: "Filter permissions" }).count(), 0, `${label}: no filters on zero permissions`);
          assert.equal(await page.getByRole("textbox", { name: "Search permissions" }).count(), 0, `${label}: no search on zero permissions`);
          assert.doesNotMatch(text, /Showing 0 of 0/, `${label}: no count on zero permissions`);
        }
        if (width === 390 && tab === "overview") {
          const chip = await page.locator(".dashboard-topbar .wallet-chip").evaluate((el) => ({ text: el.innerText.trim(), cut: [el, ...el.querySelectorAll("*")].some((node) => node.scrollWidth > node.clientWidth + 1) }));
          assert.equal(chip.text, "7R1i…sh2q", `${label}: the wallet chip shows the short address alone`);
          assert.equal(chip.cut, false, `${label}: the wallet chip is not cut off`);
        }
        if (state === "populated" && tab === "overview") {
          assert.match(text, /91\.50\s*USDC/, `${label}: spent across active permissions`);
          assert.match(text, /158\.50\s*USDC/, `${label}: remaining allowance`);
          assert.match(await page.locator(".cp-usage-ring").innerText(), /36/, `${label}: ring percentage`);
          // Spent / Remaining allowance / Limit read as one set: their labels share a line where they share a row.
          const labelTops = await page.locator(".cp-figure dt").evaluateAll((els) => els.map((el) => [Math.round(el.getBoundingClientRect().top), Math.round(el.parentElement.getBoundingClientRect().top)]));
          for (const [top, rowTop] of labelTops) assert.equal(top, rowTop, `${label}: figure label sits at the top of its figure`);
          if (width === 1440) assert.equal(new Set(labelTops.map(([top]) => top)).size, 1, `${label}: figure labels on one line`);
          // Cards that need the owner are attention items, so the attention list and the Cards panel agree.
          const attentionText = await page.locator(".cp-overview-attention").innerText();
          assert.match(attentionText, /1 card needs restore/, `${label}: a card that needs restore is an attention item`);
          assert.match(attentionText, /Freeze pending on 1 card/, `${label}: a pending card freeze is an attention item`);
          assert.match(await page.locator(".cp-overview-attention .cp-section-header").innerText(), /5 items/, `${label}: attention counts requests, expiring permissions and cards`);
          const summary = await page.locator(".cp-overview-summary").evaluate((el) => {
            const spending = el.querySelector(".cp-overview-spending").getBoundingClientRect();
            const counts = el.querySelector(".cp-overview-counts").getBoundingClientRect();
            return { spendingRight: spending.right, countsLeft: counts.left, sameRow: Math.abs(spending.top - counts.top) < 1 };
          });
          // Wide: the counts sit beside a single token's spending, so the card has no empty right half.
          if (width === 1440) assert.ok(summary.sameRow && summary.countsLeft > summary.spendingRight, `${label}: counts sit beside the spending card`);
          else assert.equal(summary.sameRow, false, `${label}: spending and counts stack below the wide layout`);
          if (width === 1440) {
            const counts = await requestCounts();
            assert.equal(counts.badge, counts.tile, `${label}: sidebar Requests badge ${counts.badge} matches Open requests ${counts.tile}`);
          }
        }
        if (state === "populated" && tab === "assistant") {
          // One date format across tabs: "Sep 15, 2026, 7:00 PM", never "9/15/2026, 7:00:00 PM".
          assert.match(text, /\b[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M\b/, `${label}: request dates use the workspace format`);
          assert.doesNotMatch(text, /\d{1,2}\/\d{1,2}\/\d{4}/, `${label}: no numeric locale dates`);
          const attention = await page.locator(".owner-request-record").count();
          if (width === 1440) assert.equal((await page.locator(".dashboard-sidebar .tool-count").innerText()).trim(), String(attention), `${label}: badge counts what Needs attention lists`);
        }
        if (state === "populated" && tab === "agents") {
          assert.doesNotMatch(text, /\bmandates?\b/i, `${label}: agent rows say permission, not mandate`);
          assert.match(text, /1 permission ·/, `${label}: assigned permission count`);
          // Destructive actions look the same here as in Settings.
          for (const revoke of await page.getByRole("button", { name: /^Revoke / }).all()) assert.match(await revoke.getAttribute("class"), /owner-danger-action/, `${label}: Revoke uses the destructive treatment`);
        }
        if (state === "populated" && tab === "mandates") {
          assert.doesNotMatch(text, /\bslot \d/i, `${label}: protocol slot numbers stay in details`);
          assert.doesNotMatch(text, /Selected/, `${label}: no unexplained Selected suffix`);
          assert.match(await page.getByRole("row", { name: /MdT3/ }).innerText(), /Expired \w{3} \d{1,2}, \d{4}/, `${label}: an expired permission says when, in the past tense`);
          assert.match(await page.getByRole("row", { name: /MdT1/ }).innerText(), /Estimated \w{3} \d{1,2}, \d{4}/, `${label}: an active permission estimates its expiry date`);
          assert.match(await page.getByRole("row", { name: /MdT1/ }).innerText(), /Remaining/, `${label}: an active permission shows what remains`);
        }
        if (state === "populated" && tab === "payments") {
          assert.match(text, /4\.500001\s*USDC/, `${label}: every significant digit kept`);
          for (const share of await page.getByRole("button", { name: /^Share receipt / }).all()) {
            const box = await share.boundingBox();
            assert.ok(box && box.width >= 44 && box.height >= 44, `${label}: share button ${box?.width}×${box?.height} is at least 44px`);
          }
          assert.ok(await page.getByRole("button", { name: /^Share receipt / }).count() > 0, `${label}: share buttons are present`);
          // One left edge per record: title, amount and status start on one column (the icon sits in its gutter).
          const edges = await page.locator(".receipt-ledger-row").evaluateAll((rows) => rows.map((row) => [".receipt-ledger-payment strong", ".receipt-ledger-amount .cp-amount", ".receipt-ledger-status .cp-status"].map((selector) => Math.round(row.querySelector(selector).getBoundingClientRect().left))));
          if (width < 1440) for (const row of edges) assert.equal(new Set(row).size, 1, `${label}: one left edge per payment record (title, amount, status at ${row.join(", ")})`);
          // Header actions wrap as one group: Export CSV and Refresh stay together.
          const [exportTop, refreshTop] = await Promise.all(["Export CSV", "Refresh"].map((name) => page.getByRole("button", { name, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().top))));
          assert.equal(exportTop, refreshTop, `${label}: Refresh is not orphaned on its own line`);
        }
        // Distinct icon per tone: a positive status is never shown with any icon but check-circle, and nothing else uses it.
        const statuses = await page.locator(".cp-status").evaluateAll((els) => els.map((el) => [el.dataset.tone, el.dataset.icon]));
        for (const [tone, icon] of statuses) assert.equal(tone === "positive", icon === "check-circle", `${label}: ${tone} status uses ${icon}`);
        await page.screenshot({ path: `${SHOTS}/${tab}-${state}-${width}.png`, fullPage: true });
      }
      // Titles do not jump between tabs with and without a header action.
      assert.equal(new Set(titleTops.values()).size, 1, `${state} ${width}: page titles sit at one height (${[...titleTops].map(([tab, top]) => `${tab} ${top}`).join(", ")})`);
    }
  }
});

// 1b. Between the three widths: ledgers and tables switch layout by their own width,
// so check the widths where a five-column table is tightest.
section("between", async () => {
  for (const width of [1180, 1024, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ["mandates", "payments", "assistant", "cards", "agents"]) {
      await open(`tab=${tab}&${POPULATED}`);
      await assertClean(`${tab} populated ${width}`);
    }
  }
});

// 2. Failed collections never read as zero or all clear.
section("failed", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await open("tab=overview&fail=1&signed-in=fixture&decimals=fixture");
    const counts = page.locator(".cp-overview-counts");
    for (const name of ["Connected agents", "Cards"]) {
      const tile = counts.locator(".cp-count").filter({ hasText: name });
      assert.equal((await tile.locator(".cp-count-value").innerText()).trim(), "—", `${name} count is a dash when it could not be read`);
      assert.match(await tile.innerText(), /Couldn’t load/);
    }
    const overview = await page.locator(".dashboard-page").innerText();
    assert.doesNotMatch(overview, /Nothing needs your attention/, "no all-clear when expiry could not be checked");
    assert.match(overview, /Expiry not checked/);
    assert.match(overview, /expiry couldn’t be checked/);
    assert.match(overview, /Couldn’t load your agents/);
    assert.match(overview, /Couldn’t load your cards/);
    assert.match(overview, /Cards not checked/, "an unreadable cards list is not counted as clear");
    await assertCheckNotes(`overview failed ${width}`);
    await assertClean(`overview failed ${width}`);
    await page.screenshot({ path: `${SHOTS}/overview-failed-${width}.png`, fullPage: true });

    await open("tab=agents&fail=1&signed-in=fixture&decimals=fixture");
    assert.match(await page.locator(".dashboard-page").innerText(), /Couldn’t load your agents/);
    await page.getByRole("button", { name: "Try again" }).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/agents-failed-${width}.png`, fullPage: true });

    await open("tab=payments&fail=1&signed-in=fixture&decimals=fixture");
    const payments = await page.locator(".dashboard-page").innerText();
    assert.match(payments, /Payment history is unavailable/);
    assert.doesNotMatch(payments, /\d+ settled/, "no settled count from data that did not load");
    await page.screenshot({ path: `${SHOTS}/payments-failed-${width}.png`, fullPage: true });
  }
});

// 3. Signed-out is not empty, and is captured.
section("signed-out", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await open("tab=agents");
    const agents = await page.locator(".dashboard-page").innerText();
    assert.match(agents, /Sign in to see your agents/);
    assert.doesNotMatch(agents, /No agents connected yet/);
    await assertClean(`agents signed-out ${width}`);
    await page.screenshot({ path: `${SHOTS}/agents-signed-out-${width}.png`, fullPage: true });
    await open("tab=overview");
    assert.equal((await page.locator(".cp-count").filter({ hasText: "Connected agents" }).locator(".cp-count-value").innerText()).trim(), "—");
    assert.match(await page.locator(".cp-count").filter({ hasText: "Connected agents" }).innerText(), /Sign in to see/);
    const signedOut = await page.locator(".dashboard-page").innerText();
    assert.doesNotMatch(signedOut, /Counts only/, `overview signed-out ${width}: no counts footnote under a sign-in prompt`);
    assert.doesNotMatch(signedOut, /Nothing needs your attention/, `overview signed-out ${width}: unread cards are not clear`);
    assert.match(signedOut, /Cards not checked/);
    await assertCheckNotes(`overview signed-out ${width}`);
    await assertClean(`overview signed-out ${width}`);
    await page.screenshot({ path: `${SHOTS}/overview-signed-out-${width}.png`, fullPage: true });
  }
});

// 4. Several tokens: totals stay apart, one ring for the selected token.
section("multi-token", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await open(`tab=overview&${POPULATED}&mints=multi`);
    const label = `overview multi-token ${width}`;
    const spending = page.locator(".cp-overview-spending");
    const token = spending.getByRole("radiogroup", { name: "Token" });
    assert.equal(await token.getByRole("radio").count(), 2, `${label}: one choice per token`);
    let figures = await spending.locator(".cp-figures").innerText();
    assert.match(figures, /91\.50\s*USDC/, `${label}: USDC spent`);
    assert.doesNotMatch(figures, /PYUSD/, `${label}: USDC figures carry no PYUSD amount`);
    assert.match(await spending.innerText(), /Across loaded permissions/);
    await assertClean(label);
    await page.screenshot({ path: `${SHOTS}/overview-multitoken-${width}.png`, fullPage: true });
    await token.getByRole("radio", { name: "PYUSD" }).click();
    figures = await spending.locator(".cp-figures").innerText();
    assert.match(figures, /12\.34\s*PYUSD/, `${label}: PYUSD spent`);
    assert.match(figures, /987\.66\s*PYUSD/, `${label}: PYUSD remaining`);
    assert.match(figures, /1,000\.00\s*PYUSD/, `${label}: PYUSD limit`);
    assert.doesNotMatch(figures, /USDC/, `${label}: PYUSD figures carry no USDC amount`);
    assert.equal(await page.locator(".cp-usage-ring").count(), 1, `${label}: still one ring`);
    assert.match(await page.locator(".cp-usage-ring").innerText(), /^\s*1\s*%?/, `${label}: ring follows the selected token`);
    await page.screenshot({ path: `${SHOTS}/overview-multitoken-pyusd-${width}.png`, fullPage: true });
  }
});

// 5. Verified clear: one slim line, only when everything was checked.
section("clear", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await open("tab=overview&signed-in=fixture&decimals=fixture&slot=fixture&receipts&clear=1");
    const label = `overview clear ${width}`;
    assert.equal(await page.locator(".cp-overview-attention").count(), 0, `${label}: no attention section`);
    const clear = page.locator(".cp-overview-clear[data-state='clear']");
    assert.equal(await clear.count(), 1, `${label}: one verified-clear line`);
    assert.match(await clear.innerText(), /Nothing needs your attention/);
    assert.equal(await clear.locator(".cp-status").getAttribute("data-icon"), "check-circle");
    await assertClearIsClear(label);
    await assertClean(label);
    await page.screenshot({ path: `${SHOTS}/overview-clear-${width}.png`, fullPage: true });

    // Everything else clear, but the card list can't be read: not an all-clear.
    await open("tab=overview&signed-in=fixture&decimals=fixture&slot=fixture&receipts&clear=1&cards=fail");
    const partial = `overview clear, cards unreadable ${width}`;
    assert.equal(await page.locator(".cp-overview-clear[data-state='clear']").count(), 0, `${partial}: no verified-clear line`);
    const note = page.locator(".cp-overview-clear[data-state='partial']");
    assert.match(await note.innerText(), /Cards not checked/, `${partial}: says the cards were not checked`);
    assert.doesNotMatch(await note.innerText(), /Expiry not checked/, `${partial}: expiry was checked`);
    assert.match(await note.innerText(), /[Yy]our cards couldn’t be read/);
    await assertCheckNotes(partial);
    await assertClean(partial);
    await page.screenshot({ path: `${SHOTS}/overview-cards-unchecked-${width}.png`, fullPage: true });
  }
});

// 6. A revoked permission: critical tone, its own icon, no Pause.
section("revoked", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await open(`tab=mandates&${POPULATED}&revoked=1`);
    const label = `mandates revoked ${width}`;
    const row = page.getByRole("row", { name: /MdT6/ });
    const status = row.locator(".cp-status");
    assert.equal(await status.innerText(), "Revoked");
    assert.equal(await status.getAttribute("data-tone"), "critical", `${label}: revoked is critical`);
    assert.ok(["ban", "x-circle"].includes(await status.getAttribute("data-icon")), `${label}: revoked uses ban or x-circle`);
    assert.equal(await row.getByRole("button", { name: /Pause|Resume/ }).count(), 0, `${label}: a revoked permission has no Pause`);
    // A revoked permission can spend nothing: its leftover is "Unspent", exact, with no expiry estimate.
    const revokedText = await row.innerText();
    assert.match(revokedText, /Unspent\s+45\.00\s*USDC/, `${label}: revoked leftover reads Unspent, exact`);
    assert.doesNotMatch(revokedText, /Remaining/, `${label}: a revoked row never says Remaining`);
    assert.doesNotMatch(revokedText, /Estimated|Expires|Expired/, `${label}: no expiry estimate on a revoked row`);
    const icons = await page.locator(".mandate-table .cp-status").evaluateAll((els) => els.map((el) => `${el.textContent}:${el.dataset.icon}`));
    assert.equal(new Set(icons.map((value) => value.split(":")[1])).size, new Set(icons.map((value) => value.split(":")[0])).size, `${label}: each status has its own icon (${icons.join(", ")})`);
    await assertClean(label);
    await page.screenshot({ path: `${SHOTS}/mandates-revoked-${width}.png`, fullPage: true });
  }
});

/**
 * Tab from the start of the page body; returns each focused control until focus leaves it.
 * `ring` compares the control focused with the same control blurred: a visible
 * outline or box-shadow that only exists (or changes) on focus. A shadow the
 * control already wears at rest is not a focus indicator.
 */
async function tabOrder(limit = 40) {
  await page.locator(".dashboard-page").evaluate((el) => { el.setAttribute("tabindex", "-1"); el.focus(); el.removeAttribute("tabindex"); });
  const order = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.closest(".dashboard-page")) return null;
      const box = el.getBoundingClientRect();
      const snapshot = () => {
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}` : "none";
        return { outline, shadow: style.boxShadow || "none" };
      };
      const focusedStyle = snapshot();
      el.blur();
      const restingStyle = snapshot();
      el.focus({ focusVisible: true });
      const ring = (focusedStyle.outline !== "none" && focusedStyle.outline !== restingStyle.outline)
        || (focusedStyle.shadow !== "none" && focusedStyle.shadow !== restingStyle.shadow);
      return {
        name: (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 60),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        visible: box.width > 0 && box.height > 0,
        ring,
        positiveTabIndex: el.tabIndex > 0,
      };
    });
    if (!focused) break;
    order.push(focused);
  }
  return order;
}

function assertInOrder(names, expected, label) {
  let from = 0;
  for (const want of expected) {
    const index = names.findIndex((name, i) => i >= from && (want instanceof RegExp ? want.test(name) : name === want));
    assert.ok(index >= 0, `${label}: "${want}" reached by Tab after position ${from} (order: ${names.join(" → ")})`);
    from = index + 1;
  }
}

// 7. Keyboard: tab order, visible focus, panel focus restoration, Pause stays reachable.
section("keyboard", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Styles are compared focused vs blurred, so no transition may be mid-flight.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(`tab=overview&${POPULATED}`);
  const overview = await tabOrder(60);
  for (const stop of overview) {
    assert.ok(stop.visible, `overview: focus on an invisible control (${stop.name})`);
    assert.ok(stop.ring, `overview: no visible focus indicator on ${stop.name}`);
    assert.ok(!stop.positiveTabIndex, `overview: positive tabindex on ${stop.name}`);
  }
  assertInOrder(overview.map((stop) => stop.name), [
    /^New permission/,
    /Ready for your review|Needs attention before/,
    /Expires within about a day/,
    "Manage permissions",
    /^Active permissions/,
    /^Connected agents/,
    /^Open requests/,
    /^Cards/,
    "View payments",
    "View agents",
    "View cards",
  ], "overview tab order");

  await open(`tab=mandates&${POPULATED}`);
  const permissions = await tabOrder(30);
  for (const stop of permissions) assert.ok(stop.ring, `permissions: no visible focus indicator on ${stop.name}`);
  const names = permissions.map((stop) => stop.name);
  assertInOrder(names, [/^New permission/, "All", "Search by name, agent or address", /MdT1/, "Pause", /MdT2/, "Resume", /MdT3/], "permissions tab order");
  assert.equal(names.filter((name) => ["All", "Active", "Paused", "Revoked", "Expired"].includes(name)).length, 1, "the filter group is one tab stop");
  // Arrow keys move within the filter group.
  await page.getByRole("radio", { name: "All", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("radio", { name: "Active", exact: true }).isChecked(), true, "ArrowRight selects the next filter");
  assert.equal(await page.getByRole("row", { name: /Inspect spending permission/ }).count(), 1);
  await page.getByRole("radio", { name: "All", exact: true }).click();

  // Sidebar → permissions → row → panel → Escape and Close both return focus to the row.
  await open(`tab=overview&${POPULATED}`);
  const sidebar = page.locator(".dashboard-sidebar");
  await sidebar.getByRole("button", { name: "Spending permissions", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Spending permissions", exact: true, level: 1 }).waitFor();
  const row = page.getByRole("row", { name: /Inspect spending permission MdT1/ });
  await row.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Spending permission" });
  await dialog.waitFor();
  const details = await dialog.textContent();
  assert.match(details, /Created/, "creation date moved into details");
  assert.match(details, /Mandate address/, "protocol IDs live in details");
  assert.match(details, /Slot 400000000/, "the expiry slot lives in details");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  assert.equal(await row.evaluate((el) => el === document.activeElement), true, "Escape returns focus to the row that opened the panel");

  const second = page.getByRole("row", { name: /Inspect spending permission MdT2/ });
  await second.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Close/ }).first().focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  assert.equal(await second.evaluate((el) => el === document.activeElement), true, "Close returns focus to the row that opened the panel");
  assert.equal(await row.getByRole("button", { name: "Pause", exact: true }).isVisible(), true, "Pause stays visible in the ledger");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

// 8. Real 200% zoom: a 1440px window at 200% is a 720 CSS px viewport at device scale 2.
section("zoom", async () => {
  const context = await browser.newContext({ viewport: { width: 720, height: 500 }, deviceScaleFactor: 2 });
  const zoomed = await context.newPage();
  zoomed.on("pageerror", (error) => errors.push(error.message));
  await blockExternal(zoomed);
  try {
    for (const tab of TABS) {
      await open(`tab=${tab}&${POPULATED}`, zoomed);
      assert.equal(await zoomed.evaluate(() => window.devicePixelRatio), 2);
      await assertClean(`${tab} 200% zoom`, zoomed);
      if (tab === "mandates") assert.equal(await zoomed.getByRole("row", { name: /MdT1/ }).getByRole("button", { name: "Pause", exact: true }).isVisible(), true, "Pause visible at 200%");
      await zoomed.screenshot({ path: `${SHOTS}/${tab}-zoom200-1440.png`, fullPage: true });
    }
  } finally {
    await context.close();
  }
});

// 9. Reduced motion: no transitions or animations anywhere in the workspace; amounts render without counting.
section("motion", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const moving = () => page.evaluate(() => [...document.querySelectorAll(".dashboard-app, .dashboard-app *, [role='dialog'], [role='dialog'] *")]
    .flatMap((el) => [el, ...["::before", "::after"].map((pseudo) => ({ el, pseudo }))])
    .map((entry) => {
      const el = entry.el ?? entry;
      const style = getComputedStyle(el, entry.pseudo);
      const durations = style.transitionDuration.split(",").map((value) => parseFloat(value));
      const moves = durations.some((value) => value > 0) || (style.animationName !== "none" && parseFloat(style.animationDuration) > 0);
      return moves ? `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join(".")}${entry.pseudo ?? ""} ${style.transitionDuration}/${style.animationName}` : null;
    })
    .filter(Boolean)
    .slice(0, 10));
  for (const tab of ["overview", "mandates", "assistant", "payments", "cards"]) {
    await open(`tab=${tab}&${POPULATED}`);
    assert.deepEqual(await moving(), [], `${tab}: something still moves with reduced motion`);
  }
  await open(`tab=mandates&${POPULATED}`);
  await page.getByRole("row", { name: /Inspect spending permission MdT1/ }).click();
  await page.getByRole("dialog", { name: "Spending permission" }).waitFor();
  assert.deepEqual(await moving(), [], "permission panel: something still moves with reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(`tab=overview&${POPULATED}`);
  const ringMotion = await page.locator(".cp-usage-ring-fill").evaluate((el) => `${getComputedStyle(el).transitionDuration}|${getComputedStyle(el).animationName}`);
  assert.equal(ringMotion, "0s|none", "the ring fill never animates");
});

try {
  for (const [name, fn] of sections) if (run(name)) await fn();
  assert.deepEqual(errors, []);
  console.log(`PASS: ${sections.filter(([name]) => run(name)).map(([name]) => name).join(", ")} — ${TABS.length} tabs × ${WIDTHS.length} widths × ${Object.keys(STATES).length} states, failed, signed-out, multi-token, verified-clear (and cards unchecked), revoked, keyboard order and focus restore, real 200% zoom, reduced motion. Screenshots in ${SHOTS}. No financial action.`);
} finally {
  await browser.close();
}
