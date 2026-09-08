import type { JSX } from 'react';
import { useSession } from '../state/session.js';
import { connectionBanner } from './round-phase.js';
import { captionStyle, panelStyle } from './styles.js';

/**
 * Says when the world on screen is not the world on the server (§42.14, §49).
 *
 * A dropped socket freezes the HUD in a state that still looks live: the
 * momentum reads SURGING, the countdown keeps falling, and none of it is true
 * any more. Naming the condition is the difference between a paused world and a
 * lying one — and while a player has SPY riding on a battle, that difference
 * matters more than the tidiness of an uninterrupted display.
 *
 * It sits above everything else in the HUD and takes no pointer events, because
 * it is information rather than a control. There is nothing to dismiss: the
 * banner leaves when the connection comes back.
 */
export function ConnectionBanner(): JSX.Element | null {
  const connection = useSession((state) => state.connection);
  const message = connectionBanner(connection);

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
        color: connection === 'OFFLINE' ? 'var(--pw-danger)' : 'var(--pw-warning)',
        borderColor: connection === 'OFFLINE' ? 'var(--pw-danger)' : 'var(--pw-warning)',
        padding: 'var(--pw-space-2) var(--pw-space-4)',
      }}
    >
      {message}
    </div>
  );
}
