import { describe, expect, it } from 'vitest';
import { parseServerArgs } from './server-args.js';

describe('how the server was asked to run', () => {
  it('serves sockets when nobody said otherwise', () => {
    // One process serving everything is what a single-instance deployment
    // wants, and is the answer for anyone who passes nothing.
    expect(parseServerArgs([])).toEqual({ ok: true, servesSockets: true });
  });

  it('gives them up when told the realtime tier is elsewhere', () => {
    expect(parseServerArgs(['--no-sockets'])).toEqual({ ok: true, servesSockets: false });
  });

  it('refuses a typo rather than quietly serving sockets anyway', () => {
    // The failure this prevents is not a crash. A deployment that runs
    // `node dist/gateway.js` beside a server that kept its sockets has two
    // realtime tiers and an ingress splitting watchers between them — half of
    // them on the process that also scores battles.
    const parsed = parseServerArgs(['--no-socket']);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem).toContain('--no-socket');
    expect(!parsed.ok && parsed.problem).toContain('Usage');
  });
});
