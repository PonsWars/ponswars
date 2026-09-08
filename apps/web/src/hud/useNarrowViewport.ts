import { useEffect, useState } from 'react';

/**
 * The width below which the HUD switches to its mobile arrangement.
 *
 * §37.4 asks for *"information presented through dedicated bottom sheets rather
 * than shrunken desktop panels"*, so the breakpoint is where two flanking intel
 * panels stop leaving the sector readable between them — roughly two 168-pixel
 * panels plus the world. It is a layout threshold, not a device test: a narrow
 * desktop window gets the sheet too, which is the point.
 */
export const NARROW_VIEWPORT_PX = 768;

/**
 * Whether the viewport is narrow enough for the bottom-sheet arrangement.
 *
 * Kept in sync with a media-query listener rather than read once, so rotating a
 * phone or dragging a window edge rearranges the HUD instead of leaving it in
 * whatever shape it was mounted in.
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => matchMediaOrNull()?.matches ?? false);

  useEffect(() => {
    const query = matchMediaOrNull();
    if (query === null) {
      return;
    }
    setNarrow(query.matches);

    const onChange = (event: MediaQueryListEvent): void => {
      setNarrow(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  return narrow;
}

/**
 * `matchMedia` where it exists.
 *
 * Returns null under a server render or a test environment without a DOM, so
 * the HUD falls back to the desktop arrangement rather than throwing before it
 * can render anything at all.
 */
function matchMediaOrNull(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia(`(max-width: ${String(NARROW_VIEWPORT_PX - 1)}px)`);
}
