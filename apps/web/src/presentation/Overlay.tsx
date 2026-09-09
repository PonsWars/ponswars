import { LAYER, MIN_TOUCH_TARGET } from '@ponswars/ui-tokens';
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { controlStyle } from '../hud/styles.js';
import { pathFor, type Route } from '../routing/route.js';

/**
 * A presentation layered over the world (§80.4, §81.2).
 *
 * The world keeps rendering behind it. Nothing here unmounts the canvas, and
 * closing returns to exactly the view the player left — §37.9 makes scene
 * persistence the point, and a profile screen that tore the world down and
 * rebuilt it would be a page in a product that has none.
 *
 * The backdrop is translucent rather than opaque, so the world stays visible
 * underneath. That is not decoration: it is what tells the player they are still
 * in the same place and one press from being back in it.
 */
export function Overlay({
  title,
  route,
  onClose,
  nav,
  children,
}: {
  readonly title: string;
  /**
   * Which presentation this is showing.
   *
   * Required rather than optional, and a route rather than a caller-chosen
   * key, because it is what decides when the page starts again from the top —
   * see the effect below. A prop each call site had to remember to pass
   * correctly is one that eventually stops being passed correctly.
   */
  readonly route: Route;
  readonly onClose: () => void;
  /**
   * The navigation bar, for presentations a visitor browses between.
   *
   * Optional, because not every presentation is one. A Genesis reveal and a
   * result are moments with one way out; putting a row of destinations across
   * the top of them would invite a player to leave the thing they opened.
   */
  readonly nav?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const path = pathFor(route);

  // Back to the top when the presentation changes.
  //
  // Every one of these renders through the same component, so React keeps the
  // scrolling element and only swaps what is inside it — which meant walking
  // from the bottom of the about page to the rewards page landed a third of the
  // way down a page nobody had scrolled, with its own heading above the fold.
  // Keyed on the path, so choosing a different faction restarts the dossier
  // too; the roster and a faction share a component but are not the same page.
  useEffect(() => {
    surface.current?.scrollTo({ top: 0 });
  }, [path]);

  useEffect(() => {
    // Focus moves into the presentation when it opens, so a keyboard or screen
    // reader user is not left several tabs behind the thing that just appeared.
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // ESC steps outward here too (§37.3). From a presentation, outward is
        // the world.
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [onClose]);

  return (
    <div
      ref={surface}
      style={{
        position: 'fixed',
        inset: 0,
        // The panel layer: above the HUD, below the card layer a Genesis
        // reveal occupies (§18). A presentation covers the interface, not the
        // card it is presenting.
        zIndex: LAYER.panel,
        display: 'flex',
        flexDirection: 'column',
        // Translucent, not opaque: the world stays visible behind it.
        background: 'var(--pw-surface-1)',
        backdropFilter: 'blur(10px)',
        overflowY: 'auto',
        padding: 'var(--pw-space-4)',
        paddingBottom: 'max(var(--pw-space-4), env(safe-area-inset-bottom))',
      }}
    >
      {nav === undefined ? null : (
        <div style={{ maxWidth: 960, width: '100%', margin: '0 auto var(--pw-space-4)' }}>
          {nav}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--pw-space-4)',
          maxWidth: 960,
          width: '100%',
          margin: '0 auto',
          marginBottom: 'var(--pw-space-4)',
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--pw-font-display)',
            fontSize: 18,
            letterSpacing: '0.1em',
            color: 'var(--pw-text-1)',
            margin: 0,
          }}
        >
          {title}
        </h1>
        <button
          type="button"
          onClick={onClose}
          style={{ ...controlStyle, minWidth: MIN_TOUCH_TARGET, fontSize: 12 }}
        >
          BACK TO WORLD
        </button>
      </div>

      <div
        ref={panel}
        tabIndex={-1}
        style={{
          display: 'grid',
          gap: 'var(--pw-space-4)',
          maxWidth: 960,
          width: '100%',
          margin: '0 auto',
          outline: 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}
