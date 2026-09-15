export const BASE_URL = (process.env.CHAINPAY_PREVIEW_URL || "http://127.0.0.1:5189").replace(/\/$/, "");

export async function launchBrowser() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  return chromium.launch({ channel: "chrome", headless: true });
}

export async function blockExternal(page) {
  await page.route("https://**/*", (route) => route.abort());
}
