import type { JSX } from 'react';
import type { Route } from '../routing/route.js';
import { controlStyle } from './styles.js';

/**
 * Entry points to the presentations layered over the world (§80.4).
 *
 * Only at the global view, where §42.7 already allows a wallet summary — from a
 * sector or a battlefield the player is mid-decision, and §42.1 keeps the HUD
 * out of the way there.
 *
 * These change the route, and the route change leaves the world scene mounted
 * (§37.9). Nothing here navigates away from anything.
 */
export function PresentationLinks({
  onNavigate,
}: {
  readonly onNavigate: (next: Route) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 'var(--pw-space-2)' }}>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 11, padding: 'var(--pw-space-2) var(--pw-space-3)' }}
        onClick={() => {
          onNavigate({ kind: 'FACTIONS', ticker: null });
        }}
      >
        FACTIONS
      </button>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 11, padding: 'var(--pw-space-2) var(--pw-space-3)' }}
        onClick={() => {
          onNavigate({ kind: 'PROFILE' });
        }}
      >
        PROFILE
      </button>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 11, padding: 'var(--pw-space-2) var(--pw-space-3)' }}
        onClick={() => {
          onNavigate({ kind: 'REWARDS' });
        }}
      >
        REWARDS
      </button>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 11, padding: 'var(--pw-space-2) var(--pw-space-3)' }}
        onClick={() => {
          onNavigate({ kind: 'GENESIS' });
        }}
      >
        GENESIS
      </button>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 11, padding: 'var(--pw-space-2) var(--pw-space-3)' }}
        onClick={() => {
          onNavigate({ kind: 'RESULT', battleId: null });
        }}
      >
        RESULT
      </button>
    </div>
  );
}
