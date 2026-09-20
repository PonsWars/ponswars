import type { AlertWebhook } from '@ponswars/config';
import type { AlertMessage, AlertSeverity } from './alerts.js';

/**
 * Sends alerts where the deployment said to (§59.3).
 *
 * Three rules, each for a reason:
 *
 * - **It never throws.** An alert that cannot be delivered is bad; a round
 *   loop taken down by one is far worse. A failed delivery is written to the
 *   log instead — without the URL, which is a secret (§87).
 * - **It keeps order.** Deliveries are chained, so a `RESOLVED` can never land
 *   before the `FIRING` it answers, which would read as the reverse of what
 *   happened.
 * - **It logs either way.** Every alert is a line in the log whether it is sent
 *   anywhere or not, so a deployment with alerts `disabled` still has the
 *   record, and one whose webhook is down still has the evidence.
 */

export interface AlertSink {
  /** Queues a message. Returns at once; delivery happens behind it. */
  readonly send: (message: AlertMessage) => void;
  /** Resolves once everything queued so far has been attempted. */
  readonly drained: () => Promise<void>;
}

/** An HTTP request to make, without making it. */
export interface AlertRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * How long one delivery may take. A constant with a reason rather than an
 * `OPEN` value: nothing a player sees depends on it, and an alert endpoint
 * slower than this is one to replace.
 */
const DELIVERY_TIMEOUT_MS = 10_000;

const NTFY_PRIORITY: Readonly<Record<AlertSeverity, string>> = {
  CRITICAL: 'urgent',
  WARNING: 'high',
  INFO: 'low',
};

const NTFY_TAG: Readonly<Record<AlertSeverity, string>> = {
  CRITICAL: 'rotating_light',
  WARNING: 'warning',
  INFO: 'information_source',
};

/** The line an alert is logged as, and the body's first line. */
export function headline(message: AlertMessage): string {
  return `[${message.status}] ${message.title}`;
}

function text(message: AlertMessage): string {
  return [message.detail, message.runbook === null ? null : `Runbook: ${message.runbook}`]
    .filter((line): line is string => line !== null)
    .join('\n\n');
}

/**
 * An ntfy publication: the text as the body, the rest as query parameters.
 *
 * Query parameters rather than ntfy's headers, because a header value must be
 * Latin-1 and an alert's title need not be — `fetch` refuses the request
 * outright rather than sending it mangled. A parameter is percent-encoded and
 * carries anything.
 *
 * A cleared condition is sent at default priority whatever it was: it is good
 * news, and good news should not wake anyone.
 */
export function ntfyRequest(url: string, message: AlertMessage): AlertRequest {
  const target = new URL(url);
  target.searchParams.set('title', headline(message));
  target.searchParams.set(
    'priority',
    message.status === 'RESOLVED' ? 'default' : NTFY_PRIORITY[message.severity],
  );
  target.searchParams.set(
    'tags',
    message.status === 'RESOLVED' ? 'white_check_mark' : NTFY_TAG[message.severity],
  );
  return {
    url: target.toString(),
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: text(message),
  };
}

/** A JSON body for any other webhook: every field, named. */
export function jsonRequest(url: string, message: AlertMessage, at: number): AlertRequest {
  return {
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: message.status,
      severity: message.severity,
      key: message.key,
      title: message.title,
      detail: message.detail,
      runbook: message.runbook,
      at: new Date(at).toISOString(),
    }),
  };
}

export function alertSink(
  target: AlertWebhook,
  options: {
    readonly say: (line: string) => void;
    readonly now: () => number;
    /** For tests. Defaults to the platform's own. */
    readonly fetch?: typeof fetch;
  },
): AlertSink {
  const post = options.fetch ?? fetch;
  let queue: Promise<void> = Promise.resolve();

  const deliver = async (message: AlertMessage): Promise<void> => {
    if (target.kind === 'DISABLED') {
      return;
    }
    const request =
      target.kind === 'NTFY'
        ? ntfyRequest(target.url, message)
        : jsonRequest(target.url, message, options.now());
    try {
      const response = await post(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        options.say(`alert not delivered: the webhook answered ${String(response.status)}\n`);
      }
    } catch (error: unknown) {
      // The reason, never the URL: the URL is the secret.
      const reason = error instanceof Error ? error.name : 'unknown error';
      options.say(`alert not delivered: ${reason}\n`);
    }
  };

  return {
    send: (message) => {
      options.say(`alert ${headline(message)}\n`);
      queue = queue.then(() => deliver(message));
    },
    drained: () => queue,
  };
}
