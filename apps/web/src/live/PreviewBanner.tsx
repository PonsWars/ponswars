import type { JSX } from 'react';
import { captionStyle, panelStyle } from '../hud/styles.js';
import type { LiveStatus } from './useLiveWorld.js';

/**
 * Says when the world on screen was never on a server at all.
 *
 * Deliberately not folded into `ConnectionBanner`, and not a fourth
 * `ConnectionState`. Those three words describe a connection that exists and is
 * struggling; this describes a build that was never given anywhere to connect
 * to, and the two would be confusing to see through the same wording. A player
 * told `OFFLINE` waits for a reconnection that is not coming.
 *
 * It is the one banner that cannot be dismissed and does not leave, because the
 * thing it reports does not change while the page is open — an unconfigured
 * build is unconfigured until it is rebuilt.
 */
export function PreviewBanner({ status }: { readonly status: LiveStatus }): JSX.Element | null {
  const message = previewMessage(status);
  if (message === null) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...panelStyle,
        ...captionStyle,
        alignSelf: 'center',
        color: 'var(--pw-warning)',
        borderColor: 'var(--pw-warning)',
        padding: 'var(--pw-space-2) var(--pw-space-4)',
      }}
    >
      {message}
    </div>
  );
}

/**
 * What to say, or nothing when the world is genuinely live.
 *
 * Exported so the wording is testable without a renderer. §110.5 asks an error
 * to say what happened and what can be done about it, and both messages below
 * name the actual condition rather than a generic failure.
 */
export function previewMessage(status: LiveStatus): string | null {
  if (!status.live) {
    return 'PREVIEW — NOT A LIVE ROUND';
  }
  if (status.lastFailure === null) {
    return null;
  }
  switch (status.lastFailure.kind) {
    case 'UNREACHABLE':
      return 'CANNOT REACH THE SERVER — DISPLAY MAY BE OUT OF DATE';
    case 'REJECTED':
      return `SERVER REFUSED THE ROUND (${String(status.lastFailure.status)})`;
    case 'MALFORMED':
      // Named separately from a refusal because it is a different problem with
      // a different owner: the server answered, and what it said does not match
      // the contract this client was built against.
      return 'THE ROUND DID NOT MATCH THE PUBLISHED CONTRACT';
  }
}
