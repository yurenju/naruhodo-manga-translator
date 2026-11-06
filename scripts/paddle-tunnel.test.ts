import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findTunnelUrl, verifyPaddleSignature } from './paddle-tunnel.ts';

describe('verifyPaddleSignature', () => {
  const secret = 'pdl_ntfset_test';
  const body = '{"event_type":"subscription.created"}';
  const h1 = createHmac('sha256', secret).update(`1700000000:${body}`).digest('hex');

  it('accepts a signature over ts:rawBody', () => {
    expect(verifyPaddleSignature(`ts=1700000000;h1=${h1}`, body, secret)).toBe(true);
  });

  it('accepts when any of several h1 values matches (secret rotation)', () => {
    expect(verifyPaddleSignature(`ts=1700000000;h1=${'0'.repeat(64)};h1=${h1}`, body, secret)).toBe(true);
  });

  it('rejects a changed body, a changed ts, or a missing header', () => {
    expect(verifyPaddleSignature(`ts=1700000000;h1=${h1}`, `${body} `, secret)).toBe(false);
    expect(verifyPaddleSignature(`ts=1700000001;h1=${h1}`, body, secret)).toBe(false);
    expect(verifyPaddleSignature('', body, secret)).toBe(false);
  });
});

describe('findTunnelUrl', () => {
  it('finds the quick tunnel URL but not cloudflared’s own API host', () => {
    const log = 'ERR failed to reach https://api.trycloudflare.com/tunnel\n|  https://quiet-fox-12.trycloudflare.com  |';
    expect(findTunnelUrl(log)).toBe('https://quiet-fox-12.trycloudflare.com');
    expect(findTunnelUrl('https://api.trycloudflare.com only')).toBeUndefined();
  });
});
