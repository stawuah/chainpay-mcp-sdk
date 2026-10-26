// Test-only bundle entry for test/paypal-tab.test.mjs. Built twice: flag off and flag on.
export { DASHBOARD_NAV_ITEMS, SIDEBAR_DASHBOARD_TABS, dashboardNavCoversAllTabs, tabEnabled } from "../../src/dashboard/nav";
export { PAYPAL_TAB_ENABLED, PAYPAL_API_URL } from "../../src/config/public";
export { parsePathname, buildPath, PAYPAL_VIEWS } from "../../src/routing/paths";
export { PaypalArea } from "../../src/dashboard/paypal/PaypalArea";
export { setPaypalSourceOverride } from "../../src/dashboard/paypal/source";
export { createFixturePaypalSource } from "../../src/dashboard/paypal/fixtureSource";
export { createLivePaypalSource } from "../../src/dashboard/paypal/liveSource";
export { configureSession, setSessionWallet, ensureSessionReady, authorizedFetch } from "../../src/session";
