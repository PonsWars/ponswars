import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import { Html } from '@react-three/drei';
import type { JSX } from 'react';
import { captionStyle, panelStyle } from '../hud/styles.js';
import type { ClientBattle } from '../state/session.js';

/**
 * The label that floats over a sector (§2.1, §37.6, §38.4).
 *
 * The visual guide asks for *"camera-aware labels"* and *"contextual overlays"*
 * over *"giant opaque sidebars"* — the world is the hero, and a matchup a player
 * can read without opening a panel is the whole difference between a world and a
 * set of shapes. Before this the sectors were unlabelled geometry: which stocks
 * were fighting where existed only in a list at the bottom of the screen.
 *
 * It is HTML rather than 3D text on purpose. §33 of the guide requires UI to be
 * *"semantic, responsive components"*, and a screen reader cannot read a mesh.
 * `Html` keeps it anchored to the sector's world position, so it moves with the
 * camera and occludes correctly instead of floating in screen space.
 *
 * Two things in the delivered mockup are deliberately not reproduced. The
 * backer counts (`1.2K`) are placeholders by §7.9 and nothing publishes a real
 * one, so inventing one here would put a fabricated number on the first screen
 * a player sees. And the corporate logos are §7.10's explicit warning — they are
 * shorthand in concept art, not cleared assets — so the faction reads through
 * its accent colour and ticker until original emblems exist.
 */

/** Sector numbering, as `S1`–`S5` (§38.4). */
function sectorTag(index: number): string {
  return `S${String(index + 1)}`;
}

export function SectorLabel({
  battle,
  index,
  onFocus,
}: {
  readonly battle: ClientBattle;
  readonly index: number;
  readonly onFocus: () => void;
}): JSX.Element {
  return (
    <Html
      // Anchored above the platform so the label clears the geometry rather
      // than sitting inside it.
      position={[0, 96, 0]}
      center
      // The world is the hero: the label must not swallow a drag meant for the
      // camera, so only the button inside it takes pointer events (§37.3).
      style={{ pointerEvents: 'none', userSelect: 'none' }}
      // No `occlude`. drei's blending mode renders an occlusion pass that
      // blanked the entire canvas here — the world went black with no error, on
      // a machine where the scene had rendered a moment before. A label that
      // stays visible through the Market Core is a smaller wrong than a world
      // that does not draw, and the ring is wide enough that it rarely happens.
      zIndexRange={[20, 0]}
    >
      <button
        type="button"
        onClick={onFocus}
        style={{
          ...panelStyle,
          pointerEvents: 'auto',
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          alignItems: 'center',
          gap: 'var(--pw-space-3)',
          padding: 'var(--pw-space-2) var(--pw-space-3)',
          whiteSpace: 'nowrap',
          color: 'var(--pw-text-1)',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            ...captionStyle,
            display: 'grid',
            placeItems: 'center',
            width: 26,
            height: 26,
            borderRadius: '50%',
            border: 'var(--pw-line-hair) solid var(--pw-border-1)',
            background: 'var(--pw-surface-1)',
            color: 'var(--pw-text-2)',
            letterSpacing: 0,
          }}
        >
          {sectorTag(index)}
        </span>

        <span style={{ display: 'grid', gap: 2 }}>
          <span
            style={{
              fontFamily: 'var(--pw-font-display)',
              fontSize: 13,
              letterSpacing: '0.06em',
            }}
          >
            <Faction ticker={battle.left} />
            <span style={{ color: 'var(--pw-text-3)', margin: '0 6px', fontSize: 11 }}>vs</span>
            <Faction ticker={battle.right} />
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            <Intel label={battle.leftIntel.label} ticker={battle.left} />
            <Intel label={battle.rightIntel.label} ticker={battle.right} />
          </span>
        </span>
      </button>
    </Html>
  );
}

/** A faction, coloured by its accent (§38.5) since emblems do not exist yet. */
function Faction({ ticker }: { readonly ticker: ClientBattle['left'] }): JSX.Element {
  return <span style={{ color: FACTION_ACCENT[ticker] }}>{ticker}</span>;
}

/**
 * One side's confidence, as a word (§10.2).
 *
 * The label and nothing else. §10 forbids an exact probability and Guide §7.1
 * lists `NVDA 67% vs AAPL 33%` as a mockup error to correct, so there is no
 * percentage available to render even if a component wanted one — the store
 * carries a snapshot of five words.
 */
function Intel({
  label,
  ticker,
}: {
  readonly label: ClientBattle['leftIntel']['label'];
  readonly ticker: ClientBattle['left'];
}): JSX.Element {
  // EVEN is the quiet case and reads as absence of a claim; the others earn a
  // tinted border so a favourite and an underdog are separable at a glance.
  const neutral = label === 'EVEN';
  return (
    <span
      style={{
        ...captionStyle,
        fontSize: 9,
        padding: '1px 6px',
        borderRadius: 'var(--pw-radius-sm)',
        border: `var(--pw-line-hair) solid ${neutral ? 'var(--pw-border-1)' : FACTION_ACCENT[ticker]}`,
        color: neutral ? 'var(--pw-text-3)' : FACTION_ACCENT[ticker],
      }}
    >
      {label.replaceAll('_', ' ')}
    </span>
  );
}
