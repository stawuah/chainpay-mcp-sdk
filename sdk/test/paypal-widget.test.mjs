import assert from 'node:assert/strict';
import test from 'node:test';
import { paypalWorkspaceUrl, PAYPAL_SERVICE_IDS } from '../dist/paypal-widget.js';
test('handoff carries only registered service ID to an explicit safe origin', () => {
  for (const id of PAYPAL_SERVICE_IDS) {
    const url = new URL(paypalWorkspaceUrl('https://workspace.example', id));
    assert.equal(url.origin, 'https://workspace.example');
    assert.equal(url.pathname, '/paypal/');
    assert.deepEqual([...url.searchParams], [['service', id]]);
    assert.equal(url.hash, '');
  }
  assert.equal(new URL(paypalWorkspaceUrl('http://localhost:5197', PAYPAL_SERVICE_IDS[0])).protocol, 'http:');
  for (const origin of ['http://remote.example', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/a/..', 'https://example.com?token=secret', 'https://example.com#private', '//example.com', 'https://chainpayai.app', 'https://example.com/\\evil']) {
    assert.throws(() => paypalWorkspaceUrl(origin, PAYPAL_SERVICE_IDS[0]), origin);
  }
  assert.throws(() => paypalWorkspaceUrl('https://workspace.example', 'unknown'));
});

test('production origins cannot bypass isolation with trailing DNS dots', () => {
  for (const host of ['chainpayai.app','www.chainpayai.app','a.b.chainpayai.app','chainpay-relay.vercel.app']) {
    for (const suffix of ['', '.']) assert.throws(() => paypalWorkspaceUrl(`https://${host}${suffix}`, PAYPAL_SERVICE_IDS[0]));
  }
});
