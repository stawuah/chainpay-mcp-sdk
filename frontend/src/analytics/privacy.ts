import type { BeforeSendEvent } from '@vercel/analytics';

// Count page categories without exporting wallet/receipt IDs, signed request
// fragments, arbitrary query values, or unknown paths to analytics.
const staticPages = new Set(['/', '/pet', '/verify', '/app', '/app/overview', '/app/mandates', '/app/mandates/new', '/app/payments', '/app/agents', '/app/receipts', '/app/assistant', '/app/requests', '/app/requests/permission', '/app/tools', '/app/connect-mcp', '/app/settings', '/app/protocol', '/app/settings/advanced', '/app/settings/advanced/tools', '/app/settings/advanced/protocol', '/embed/overview']);
export function analyticsBeforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  if (event.type !== 'pageview') return null;
  try {
    const url = new URL(event.url);
    let path = url.pathname.replace(/\/+$/, '') || '/';
    if (/^\/verify\/[^/]+$/.test(path)) path = '/verify';
    else if (/^\/embed\/overview\/[^/]+$/.test(path)) path = '/embed/overview';
    else if (/^\/app\/(mandates|receipts)\/[^/]+$/.test(path) && path !== '/app/mandates/new') path = path.startsWith('/app/mandates/') ? '/app/mandates' : '/app/receipts';
    if (!staticPages.has(path)) return null;
    url.pathname = path; url.search = ''; url.hash = '';
    return { ...event, url: url.href };
  } catch { return null; }
}
