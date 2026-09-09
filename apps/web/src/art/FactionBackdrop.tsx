import { LAYER } from '@ponswars/ui-tokens';
import type { ActiveTicker } from '@ponswars/shared-types';
import type { JSX } from 'react';
import { FACTION_ART } from './manifest.js';

/**
 * The two armies, flanking the sector a player is looking at (§39, §42.4).
 *
 * The delivered battle-sector mockup makes this the dominant image on the
 * screen: the factions fill the left and right thirds and the battlefield sits
 * between them. That is what a war between two stocks is supposed to look like,
 * and until now the same screen was two coloured boxes on black.
 *
 * The centre stays clear, which is the whole reason this is two edge-anchored
 * images rather than one background. §2.1 keeps the world dominant and rules out
 * covering the battlefield; each side fades to nothing well before the middle,
 * so the sector, the frontline and the pick controls are never behind art.
 *
 * It sits below the HUD and above the canvas. A player reads the intel panels
 * over the top of their own faction, exactly as the mockup arranges it.
 *
 * Decorative throughout: `aria-hidden`, empty `alt`. Every fact these images
 * carry — which factions, which side, what their intel says — is already text
 * in the panels above them, which is what §36.7 requires of anything that has
 * to survive without colour or pictures.
 */
export function FactionBackdrop({
  left,
  right,
}: {
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
}): JSX.Element {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        // Below the HUD, above the world canvas. Never takes a pointer event:
        // a drag that starts over an army is still a drag on the world (§37.3).
        zIndex: LAYER.hud - 1,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <Flank ticker={left} side="left" />
      <Flank ticker={right} side="right" />
    </div>
  );
}

function Flank({
  ticker,
  side,
}: {
  readonly ticker: ActiveTicker;
  readonly side: 'left' | 'right';
}): JSX.Element {
  // Masked toward the centre and softened at top and bottom, so the art reads
  // as the edge of a scene rather than as a photograph pasted on.
  const fade = side === 'left' ? 'to right' : 'to left';

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: 0,
        width: 'min(42vw, 720px)',
        maskImage: `linear-gradient(${fade}, black 12%, transparent 92%)`,
        WebkitMaskImage: `linear-gradient(${fade}, black 12%, transparent 92%)`,
      }}
    >
      <img
        src={FACTION_ART[ticker]}
        alt=""
        // Eager, because this component only exists once a player has already
        // descended to a sector — the global view never mounts it, so there are
        // never ten of these to pay for. Deferring the dominant image of a
        // screen that has just been opened only makes it arrive late.
        loading="eager"
        decoding="async"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          // The dossiers are wide scenes with their army massed toward the
          // outer edge; anchoring there keeps the troops on screen instead of
          // the empty sky above them.
          objectPosition: side === 'left' ? '18% center' : '82% center',
          opacity: 0.62,
          // Scene-linked rather than pasted over: the art tints the darkness it
          // sits in instead of sitting on top of it.
          mixBlendMode: 'screen',
          transform: side === 'right' ? 'scaleX(-1)' : undefined,
        }}
      />
    </div>
  );
}
