import type { ActiveTicker, CardDecision } from '@ponswars/shared-types';
import { FACTION_ACCENT, RARITY_COLOR } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { useSession, type ClientBattle, type PickAttempt } from '../state/session.js';
import { cardStateLabel, pickFlowView, type PickFlowView } from './pick-flow.js';
import { roundView } from './round-phase.js';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from './styles.js';

/**
 * Backing a side and deciding the card (§27.6, §42.5, §40.7).
 *
 * The sequence is §40.7's: choose a faction, the Genesis Card enters, USE or
 * SAVE, and at lock an armed card becomes deployed. `pickFlowView` decides which
 * of those stages the player is in; this renders it. Which controls exist at all
 * comes from that view, because §42.1 would rather show less UI than a control
 * that cannot be used.
 *
 * Nothing here claims a pick is settled. §22 makes the lock authoritative and the
 * confirmed backing comes back on round state — a client that renders its own
 * optimistic guess as final is how a player believes they are in a war they
 * never entered, or that they spent a card use they still hold.
 */
export function PickControls({ battle }: { readonly battle: ClientBattle }): JSX.Element {
  const pendingPick = useSession((state) => state.pendingPick);
  const proposePick = useSession((state) => state.proposePick);
  const cardDecision = useSession((state) => state.cardDecision);
  const decideCard = useSession((state) => state.decideCard);
  const card = useSession((state) => state.card);
  const round = useSession((state) => state.round);
  const picks = useSession((state) => state.picks);
  const setPickError = useSession((state) => state.setPickError);
  const pickError = useSession((state) => state.pickError);

  /**
   * Sends a decision, and keeps the local one only if the server took it.
   *
   * A client that kept its optimistic state after a refusal would show the
   * player backing a stock the round never recorded — §22 makes the lock
   * authoritative, and a refused pick is exactly the case where the two must
   * not diverge. With no gateway there is nobody to tell, so the local state
   * stands on its own.
   */
  const send = (attempt: () => Promise<PickAttempt>, undo: () => void): void => {
    setPickError(null);
    void attempt().then((result) => {
      if (!result.ok) {
        undo();
        setPickError({ message: result.message, nextStep: result.nextStep });
      }
    });
  };

  const picksAllowed = round !== null && roundView(round.state, round.clock).picksAllowed;
  const proposed = pendingPick?.battleId === battle.battleId;
  const flow = pickFlowView({
    picksAllowed,
    backing: battle.backing,
    pickProposed: proposed,
    card,
    decision: cardDecision,
  });

  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)', minWidth: 190 }}>
      <Side battle={battle} flow={flow} proposedTicker={proposed ? pendingPick.ticker : null} />

      {flow.stage === 'CHOOSE_SIDE' ? (
        <div style={{ display: 'flex', gap: 'var(--pw-space-2)' }}>
          {[battle.left, battle.right].map((ticker) => (
            <BackButton
              key={ticker}
              ticker={ticker}
              pending={false}
              onPick={() => {
                proposePick({ battleId: battle.battleId, ticker });
                if (picks !== null) {
                  send(
                    () => picks.back(battle.battleId, ticker),
                    () => {
                      proposePick(null);
                    },
                  );
                }
              }}
            />
          ))}
        </div>
      ) : null}

      {flow.stage === 'CARD_DECISION' || flow.stage === 'COMMITTED' ? (
        <CardPanel
          flow={flow}
          onDecide={(decision) => {
            const previous = cardDecision;
            decideCard(decision);
            if (picks !== null && decision !== null) {
              send(
                () => picks.decide(decision),
                () => {
                  decideCard(previous);
                },
              );
            }
          }}
        />
      ) : null}

      {pickError === null ? null : (
        <div
          role="status"
          aria-live="polite"
          style={{ ...captionStyle, color: 'var(--pw-danger)' }}
        >
          <div>{pickError.message}</div>
          <div style={{ color: 'var(--pw-text-3)' }}>{pickError.nextStep}</div>
        </div>
      )}

      {flow.mayChangePick ? (
        <button
          type="button"
          style={{ ...controlStyle, fontSize: 11, padding: 'var(--pw-space-2) var(--pw-space-3)' }}
          onClick={() => {
            // §27.6: a pick may be changed until lock. Clearing returns the
            // player to CHOOSE_SIDE rather than to a half-committed state, and
            // withdraws it on the server so the round does not lock a pick the
            // player has abandoned (§47.5).
            proposePick(null);
            decideCard(null);
            if (picks !== null) {
              send(
                () => picks.withdraw(),
                () => undefined,
              );
            }
          }}
        >
          CHANGE PICK
        </button>
      ) : null}
    </div>
  );
}

/** Which side the player is on, and how settled that is. */
function Side({
  battle,
  flow,
  proposedTicker,
}: {
  readonly battle: ClientBattle;
  readonly flow: PickFlowView;
  readonly proposedTicker: ActiveTicker | null;
}): JSX.Element {
  if (battle.backing !== null) {
    return (
      <div>
        <div style={captionStyle}>YOU BACKED</div>
        <div style={{ ...readoutStyle, color: FACTION_ACCENT[battle.backing.ticker] }}>
          {battle.backing.ticker}
        </div>
      </div>
    );
  }

  // Only while the phase is open. A proposal the server never confirmed must
  // not keep saying SENDING PICK after lock — by then it either landed, in
  // which case `backing` says so above, or it did not and the player is
  // spectating. A permanent "sending" is the fabricated state §42.14 rules out.
  if (proposedTicker !== null && flow.stage === 'CARD_DECISION') {
    return (
      <div>
        <div style={captionStyle}>BACKING</div>
        <div style={{ ...readoutStyle, color: FACTION_ACCENT[proposedTicker] }}>
          {proposedTicker}
        </div>
        {/* §42.14 asks for useful sync states. "Sending" is the truth: the pick
            is not real until the round state says it is. */}
        <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>SENDING PICK…</div>
      </div>
    );
  }

  return (
    <div style={captionStyle}>{flow.stage === 'SPECTATING' ? 'SPECTATING' : 'CHOOSE A SIDE'}</div>
  );
}

/**
 * The Genesis Card in the interaction layer (§40.7 step 2).
 *
 * §40.8 keeps the card off the battlefield itself — *"do not cover the battle
 * with a giant card"* — so this stays a panel-sized cue during Pick Phase and a
 * readout afterwards.
 */
function CardPanel({
  flow,
  onDecide,
}: {
  readonly flow: PickFlowView;
  readonly onDecide: (decision: CardDecision | null) => void;
}): JSX.Element {
  const card = useSession((state) => state.card);

  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gap: 'var(--pw-space-2)',
        borderColor: card === null ? 'var(--pw-border-1)' : RARITY_COLOR[card.rarity],
      }}
    >
      <div style={captionStyle}>GENESIS CARD</div>
      <div style={{ ...readoutStyle, fontSize: 14 }}>{card?.name.toUpperCase() ?? '—'}</div>

      <div style={{ display: 'flex', gap: 'var(--pw-space-3)', alignItems: 'baseline' }}>
        {flow.usesLabel === null ? null : (
          <span className="pw-tabular" style={{ fontSize: 14, color: 'var(--pw-text-1)' }}>
            {flow.usesLabel}
          </span>
        )}
        {flow.finalUse ? (
          <span style={{ ...captionStyle, color: 'var(--pw-warning)' }}>FINAL USE</span>
        ) : null}
      </div>

      <div
        style={{
          ...captionStyle,
          color: flow.cardState === 'ARMED' ? 'var(--pw-accent)' : 'var(--pw-text-2)',
        }}
      >
        {cardStateLabel(flow.cardState)}
      </div>

      {flow.mayDecideCard ? (
        <div style={{ display: 'flex', gap: 'var(--pw-space-2)' }}>
          <button
            type="button"
            aria-pressed={flow.cardState === 'ARMED'}
            style={{
              ...controlStyle,
              fontSize: 11,
              padding: 'var(--pw-space-2) var(--pw-space-3)',
              borderColor: flow.cardState === 'ARMED' ? 'var(--pw-accent)' : 'var(--pw-border-1)',
            }}
            onClick={() => {
              onDecide('USE');
            }}
          >
            USE CARD
          </button>
          <button
            type="button"
            aria-pressed={flow.cardState === 'SAVED'}
            style={{
              ...controlStyle,
              fontSize: 11,
              padding: 'var(--pw-space-2) var(--pw-space-3)',
              borderColor: flow.cardState === 'SAVED' ? 'var(--pw-accent)' : 'var(--pw-border-1)',
            }}
            onClick={() => {
              onDecide('SAVE');
            }}
          >
            SAVE CARD
          </button>
        </div>
      ) : null}

      {flow.cardState === 'ARMED' ? (
        // §40.7 step 5: arming is not spending. The use is consumed at lock, and
        // saying so is what makes CHANGE PICK feel safe rather than costly.
        <div style={{ fontSize: 11, color: 'var(--pw-text-3)' }}>
          Consumed at lock. Nothing is spent until then.
        </div>
      ) : null}
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
