import { useEffect, useRef, type JSX } from 'react';
import { PonsWarsMark, PonsWarsWordmark } from '../art/PonsWarsMark.js';
import { pathFor, type Route } from '../routing/route.js';
import { WalletConnect } from './WalletConnect.js';
import { captionStyle, panelStyle } from './styles.js';
import { useNarrowViewport } from './useNarrowViewport.js';

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
  const narrow = useNarrowViewport();
  const destinations = useRef<HTMLDivElement | null>(null);

  // Where you are, scrolled into sight. On a phone the row scrolls and the
  // later destinations start off the edge; arriving on the rewards page with
  // its own tab hidden is a bar that does not say where you are.
  useEffect(() => {
    const row = destinations.current;
    const here = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (row === null || here === null || here === undefined) {
      return;
    }
    const hidden =
      here.offsetLeft < row.scrollLeft ||
      here.offsetLeft + here.offsetWidth > row.scrollLeft + row.clientWidth;
    if (hidden) {
      row.scrollLeft = Math.max(0, here.offsetLeft - (row.clientWidth - here.offsetWidth) / 2);
    }
  }, [current.kind, narrow]);

  return (
    <nav
      aria-label="PonsWars"
      style={{
        ...panelStyle,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: narrow ? 'var(--pw-space-1) var(--pw-space-3)' : 'var(--pw-space-4)',
        padding: 'var(--pw-space-2) var(--pw-space-3)',
        flexWrap: 'wrap',
        // The bar is laid out inside rows that distribute their children to
        // opposite edges. Without a ceiling it takes its intrinsic width — on a
        // 375-pixel screen that pushed four destinations and the wallet off the
        // right of the viewport, where nothing could reach them.
        maxWidth: '100%',
        minWidth: 0,
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
          flex: 'none',
        }}
      >
        <PonsWarsMark size={22} />
        <PonsWarsWordmark />
      </a>

      <div
        ref={destinations}
        style={{
          display: 'flex',
          gap: 'var(--pw-space-1)',
          // On a phone: a row of its own under the mark and the wallet, the full
          // width of the bar. Left to wrap on its own it took the second line
          // and pushed the wallet onto a third, right-aligned under nothing —
          // a bar a third of the screen tall with a hole in the middle of it.
          ...(narrow
            ? {
                order: 2,
                flexBasis: '100%',
                // The row scrolls, and a hard cut through a word reads as a
                // clipping bug. A fade at the edge reads as more to come.
                maskImage: 'linear-gradient(to right, #000 82%, transparent)',
                WebkitMaskImage: 'linear-gradient(to right, #000 82%, transparent)',
              }
            : {}),
          // One row that scrolls, rather than a block that wraps into a column.
          // Seven destinations wrapped at phone width turn the bar into a
          // menu the height of the screen, over the world it is supposed to
          // float on.
          flexWrap: 'nowrap',
          overflowX: 'auto',
          minWidth: 0,
          // The row owns horizontal scrolling; every other gesture stays with
          // the world beneath it (§37.3).
          touchAction: 'pan-x',
          scrollbarWidth: 'none',
        }}
      >
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
                // A scrolling row must not compress its own items to fit.
                flex: 'none',
              }}
            >
              {destination.label}
            </a>
          );
        })}
      </div>

      {/*
        The wallet lives at the right edge of every bar, on every surface, which
        is where each delivered mockup puts it. §5 makes it an offer rather than
        a gate: a visitor who never presses it sees the entire world.
      */}
      <div
        style={{
          marginLeft: 'auto',
          ...(narrow ? { order: 1 } : {}),
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--pw-space-3)',
          flex: 'none',
        }}
      >
        {children}
        <WalletConnect compact={narrow} />
      </div>
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
