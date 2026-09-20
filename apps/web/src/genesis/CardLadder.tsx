import { RARITY_COLOR } from '@ponswars/ui-tokens';
import { useMemo, type JSX } from 'react';
import { captionStyle, humanize, panelStyle, readoutStyle } from '../hud/styles.js';
import { cardLadder } from './card-ladder.js';

/**
 * What a Genesis Card can be (§7.2, §15, §40).
 *
 * The Genesis page said one thing and then stopped, leaving half a screen of
 * nothing under it — which reads as a page that failed rather than one that
 * has finished speaking. This is what belongs in that space: the pool itself,
 * read from the locked catalog rather than described beside it.
 *
 * Every rung says what its cards contribute, in the same words the card face
 * uses. §15 is the line it must not cross: support is a contribution to a
 * side's score, never extra units, and there is no number here that is not the
 * engine's own.
 */
export function CardLadder(): JSX.Element {
  const rungs = useMemo(() => cardLadder(), []);

  return (
    <section style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-4)' }}>
      <div style={{ display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={captionStyle}>THE CARD POOL</div>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>
          ONE CARD, DEALT ONCE, KEPT FOREVER
        </h2>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>
          A card is dealt from a Robinhood Chain block that does not exist yet when it is asked for.
          Deploying one adds its support to the side you backed while the battle is scored — it
          never adds troops, and it never decides a battle on its own.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--pw-space-4)',
        }}
      >
        {rungs.map((rung) => (
          <div
            key={rung.rarity}
            style={{
              display: 'grid',
              gap: 'var(--pw-space-2)',
              alignContent: 'start',
              paddingLeft: 'var(--pw-space-3)',
              borderLeft: `2px solid ${RARITY_COLOR[rung.rarity]}`,
            }}
          >
            <div style={{ ...captionStyle, color: RARITY_COLOR[rung.rarity] }}>
              {humanize(rung.rarity)}
            </div>
            {rung.cards.map((card) => (
              <div key={card.type} style={{ display: 'grid', gap: 2 }}>
                <div style={{ fontSize: 13, color: 'var(--pw-text-1)' }}>{card.name}</div>
                <div style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>{card.effect}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
