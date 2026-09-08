import type { ActiveTicker } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { useSession, type ClientBattle } from '../state/session.js';
import { roundView } from './round-phase.js';
import { captionStyle, controlStyle, panelStyle } from './styles.js';

/**
 * Backing a side (§42.5).
 *
 * The sequence §42.5 recommends is: focus a faction, give that side emphasis,
 * offer `BACK <TICKER>`, then bring the Genesis Card in as a spatial object and
 * reduce the panel after the decision. This is the first three steps; the card
 * is a world object rather than a HUD element, so it arrives with the card
 * system rather than here.
 *
 * A pressed button proposes a pick. It does not claim one. §22 makes the lock
 * authoritative and the confirmed backing comes back on round state, so until it
 * does the panel says the request is in flight — a client that renders its own
 * optimistic guess as settled is how a player believes they are in a war they
 * never entered.
 */
export function PickControls({ battle }: { readonly battle: ClientBattle }): JSX.Element {
  const pendingPick = useSession((state) => state.pendingPick);
  const proposePick = useSession((state) => state.proposePick);
  const round = useSession((state) => state.round);

  // Picks close at lock and never reopen (§3.2, §22). The buttons go away
  // rather than being shown disabled: an inert CTA still reads as an offer, and
  // §42.1 would rather show less UI than a control that cannot be used.
  const picksAllowed = round !== null && roundView(round.state, round.clock).picksAllowed;

  if (battle.backing !== null) {
    return (
      <div style={panelStyle}>
        <div style={captionStyle}>YOU BACKED</div>
        <div
          style={{
            fontFamily: 'var(--pw-font-display)',
            fontSize: 18,
            color: FACTION_ACCENT[battle.backing.ticker],
          }}
        >
          {battle.backing.ticker}
        </div>
      </div>
    );
  }

  if (!picksAllowed) {
    return (
      <div style={panelStyle}>
        <div style={captionStyle}>YOUR BACKING</div>
        <div style={{ fontFamily: 'var(--pw-font-display)', fontSize: 15 }}>SPECTATING</div>
      </div>
    );
  }

  const pending = pendingPick?.battleId === battle.battleId ? pendingPick.ticker : null;

  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>CHOOSE A SIDE</div>
      <div style={{ display: 'flex', gap: 'var(--pw-space-2)' }}>
        <BackButton
          ticker={battle.left}
          pending={pending === battle.left}
          onPick={() => {
            proposePick({ battleId: battle.battleId, ticker: battle.left });
          }}
        />
        <BackButton
          ticker={battle.right}
          pending={pending === battle.right}
          onPick={() => {
            proposePick({ battleId: battle.battleId, ticker: battle.right });
          }}
        />
      </div>
      {pending === null ? null : (
        <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>
          {/*
            §42.14 asks for useful sync states. "Sending" is the truth: the pick
            is not real until the round state says it is.
          */}
          SENDING PICK…
        </div>
      )}
    </div>
  );
}

function BackButton({
  ticker,
  pending,
  onPick,
}: {
  readonly ticker: ActiveTicker;
  readonly pending: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={pending}
      style={{
        ...controlStyle,
        padding: 'var(--pw-space-2) var(--pw-space-4)',
        fontFamily: 'var(--pw-font-display)',
        fontSize: 13,
        // §42.5 step 2: the chosen side takes subtle emphasis. A border, not a
        // fill — the world stays the hero (§42.1).
        borderColor: pending ? FACTION_ACCENT[ticker] : 'var(--pw-border-1)',
      }}
    >
      BACK {ticker}
    </button>
  );
}
