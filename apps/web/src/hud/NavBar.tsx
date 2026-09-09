import type { JSX } from 'react';
import { PonsWarsMark, PonsWarsWordmark } from '../art/PonsWarsMark.js';
import { pathFor, type Route } from '../routing/route.js';
import { captionStyle, panelStyle } from './styles.js';

/**
 * One navigation bar, on every surface (§80.4, and every delivered mockup).
 *
 * The mark, the destinations, and where you currently are. Each mockup carries
 * the same bar across the top — the world, the landing, the faction pages — and
 * the app had a row of unlabelled buttons in one corner of the world and
 * nothing anywhere else. A player who reached the about page could not get to
 * the factions from it.
 *
 * It is a real `<nav>` with real links. Every destination is a shareable route
 * (§80.4), so these are `<a href>` that a browser can open in a new tab, middle
 * click or bookmark — and they still route in place, because a route change
 * must not destroy the world scene (§37.9). A row of buttons cannot do any of
 * that.
 *
 * Tactical glass and thin borders, not a solid header (§2.1): the world is
 * visible through it wherever it sits over one.
 */

/** Where the bar can take you, in the order the mockups list them. */
const DESTINATIONS: readonly { readonly label: string; readonly route: Route }[] = [
  { label: 'HOME', route: { kind: 'LANDING' } },
  { label: 'WORLD', route: { kind: 'WORLD', battleId: null } },
  { label: 'FACTIONS', route: { kind: 'FACTIONS', ticker: null } },
  { label: 'GENESIS', route: { kind: 'GENESIS' } },
  { label: 'REWARDS', route: { kind: 'REWARDS' } },
  { label: 'PROFILE', route: { kind: 'PROFILE' } },
  { label: 'ABOUT', route: { kind: 'ABOUT' } },
];

export function NavBar({
  current,
  onNavigate,
  children,
}: {
  readonly current: Route;
  readonly onNavigate: (next: Route) => void;
  /** The wallet summary, or anything else that belongs at the right edge. */
  readonly children?: JSX.Element | null;
}): JSX.Element {
  return (
    <nav
      aria-label="PonsWars"
      style={{
        ...panelStyle,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--pw-space-4)',
        padding: 'var(--pw-space-2) var(--pw-space-3)',
        flexWrap: 'wrap',
      }}
    >
      <a
        href={pathFor({ kind: 'LANDING' })}
        onClick={(event) => {
          if (isPlainClick(event)) {
            event.preventDefault();
            onNavigate({ kind: 'LANDING' });
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--pw-space-2)',
          textDecoration: 'none',
        }}
      >
        <PonsWarsMark size={22} />
        <PonsWarsWordmark />
      </a>

      <div style={{ display: 'flex', gap: 'var(--pw-space-1)', flexWrap: 'wrap' }}>
        {DESTINATIONS.map((destination) => {
          const here = destination.route.kind === current.kind;
          return (
            <a
              key={destination.label}
              href={pathFor(destination.route)}
              aria-current={here ? 'page' : undefined}
              onClick={(event) => {
                if (isPlainClick(event)) {
                  event.preventDefault();
                  onNavigate(destination.route);
                }
              }}
              style={{
                ...captionStyle,
                textDecoration: 'none',
                padding: 'var(--pw-space-2) var(--pw-space-2)',
                borderRadius: 'var(--pw-radius-sm)',
                // Where you are, marked by a line under it rather than a filled
                // pill: §2.1 keeps chrome light, and a solid block in a bar that
                // floats over the world reads as a button that does nothing.
                borderBottom: `2px solid ${here ? 'var(--pw-accent)' : 'transparent'}`,
                color: here ? 'var(--pw-text-1)' : 'var(--pw-text-3)',
              }}
            >
              {destination.label}
            </a>
          );
        })}
      </div>

      {children === undefined ? null : (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>{children}</div>
      )}
    </nav>
  );
}

/**
 * Whether a click means "go there in this tab".
 *
 * A modified click is the browser's, not ours: ctrl or cmd opens a new tab,
 * shift a new window, and middle click does the same. Intercepting those would
 * silently break the one thing links do that buttons cannot.
 */
function isPlainClick(event: React.MouseEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}
