import { describe, expect, it, vi } from 'vitest';
import { alertSink, jsonRequest, ntfyRequest } from './alert-sink.js';
import type { AlertMessage } from './alerts.js';

/**
 * Sending alerts where the deployment said to (§59.3).
 */

const FIRING: AlertMessage = {
  status: 'FIRING',
  key: 'round-stuck:r1',
  severity: 'CRITICAL',
  title: 'Round r1 is not finalizing — §25',
  detail: 'Still FINALIZING, 12 minutes past its battle end.',
  runbook: 'docs/operations/round-stuck.md',
};

const RESOLVED: AlertMessage = { ...FIRING, status: 'RESOLVED' };

const NTFY_URL = 'https://ntfy.sh/secret-topic-name';

describe('an ntfy publication', () => {
  it('wakes someone for a critical alert, and names the runbook', () => {
    const request = ntfyRequest(NTFY_URL, FIRING);
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe(NTFY_URL);
    expect(url.searchParams.get('priority')).toBe('urgent');
    expect(url.searchParams.get('title')).toBe('[FIRING] Round r1 is not finalizing — §25');
    expect(request.body).toContain('12 minutes past');
    expect(request.body).toContain('Runbook: docs/operations/round-stuck.md');
  });

  it('carries a title a header could not, as a parameter', () => {
    // A header value must be Latin-1; fetch refuses the request otherwise, so a
    // title with an em dash in it would never have been sent at all.
    expect(Object.values(ntfyRequest(NTFY_URL, FIRING).headers).join('')).not.toContain('—');
  });

  it('does not wake anyone to say something cleared', () => {
    const url = new URL(ntfyRequest(NTFY_URL, RESOLVED).url);
    expect(url.searchParams.get('priority')).toBe('default');
    expect(url.searchParams.get('tags')).toBe('white_check_mark');
  });
});

describe('a JSON webhook body', () => {
  it('names every field and when it happened', () => {
    const body = JSON.parse(jsonRequest('https://hooks.example.invalid/x', FIRING, 0).body) as {
      readonly status: string;
      readonly key: string;
      readonly at: string;
    };

    expect(body.status).toBe('FIRING');
    expect(body.key).toBe('round-stuck:r1');
    expect(body.at).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('the sink', () => {
  it('sends in the order it was told, so a clear never lands before its alarm', async () => {
    const seen: string[] = [];
    // The first delivery is the slow one: order must still hold.
    const post = vi.fn(async (_url: string, init: RequestInit) => {
      const body = typeof init.body === 'string' ? init.body : '';
      if (seen.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      seen.push(body.includes('FIRING') ? 'FIRING' : 'RESOLVED');
      return new Response(null, { status: 200 });
    });
    const sink = alertSink(
      { kind: 'JSON', url: 'https://hooks.example.invalid/x' },
      { say: () => undefined, now: () => 0, fetch: post as unknown as typeof fetch },
    );

    sink.send(FIRING);
    sink.send(RESOLVED);
    await sink.drained();

    expect(seen).toEqual(['FIRING', 'RESOLVED']);
  });

  it('never throws, and reports a failure without the URL (§87)', async () => {
    const lines: string[] = [];
    const post = vi.fn(() => Promise.reject(new TypeError(`fetch failed for ${NTFY_URL}`)));
    const sink = alertSink(
      { kind: 'NTFY', url: NTFY_URL },
      {
        say: (line) => lines.push(line),
        now: () => 0,
        fetch: post,
      },
    );

    expect(() => {
      sink.send(FIRING);
    }).not.toThrow();
    await sink.drained();

    expect(lines.join('')).toContain('alert not delivered: TypeError');
    expect(lines.join('')).not.toContain('secret-topic-name');
  });

  it('says so when the webhook refuses', async () => {
    const lines: string[] = [];
    const post = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    const sink = alertSink(
      { kind: 'NTFY', url: NTFY_URL },
      {
        say: (line) => lines.push(line),
        now: () => 0,
        fetch: post,
      },
    );

    sink.send(FIRING);
    await sink.drained();

    expect(lines.join('')).toContain('answered 403');
  });

  it('logs every alert even when alerts are disabled, and sends nothing', async () => {
    const lines: string[] = [];
    const post = vi.fn();
    const sink = alertSink(
      { kind: 'DISABLED' },
      {
        say: (line) => lines.push(line),
        now: () => 0,
        fetch: post,
      },
    );

    sink.send(FIRING);
    await sink.drained();

    expect(post).not.toHaveBeenCalled();
    expect(lines.join('')).toContain('alert [FIRING] Round r1 is not finalizing');
  });
});
