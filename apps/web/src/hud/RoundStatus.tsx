import { useEffect, useState, type JSX } from 'react';
import { useSession } from '../state/session.js';
import { formatCountdown, roundView } from './round-phase.js';
import { captionStyle, panelStyle } from './styles.js';

/**
 * Round identity and phase (§22, §42.2).
 *
 * The phase comes from the authoritative round state, not from the clock. A HUD
 * that infers "the battle must be live by now" from a timer is exactly the
 * synthesized state the engineering rules forbid — if the server has not said
 * `BATTLE_LIVE`, the round is not live, however long the countdown has run.
 */
export function RoundStatus(): JSX.Element {
  const round = useSession((state) => state.round);

  if (round === null) {
    // §42.14: a useful sync state, not a fabricated phase.
    return (
      <div style={panelStyle}>
        <div style={captionStyle}>PONSWARS</div>
        <div style={{ ...phaseStyle, color: 'var(--pw-text-3)' }}>SYNCING</div>
      </div>
    );
  }

  const view = roundView(round.state, round.clock);

  return (
    <div style={panelStyle}>
      <div style={captionStyle}>PONSWARS</div>
      <div
        style={{
          ...phaseStyle,
          // A voided round is called out rather than blending into the phase
          // sequence. §4.4 never revives one, and nothing further is coming.
          color: view.voided ? 'var(--pw-danger)' : 'var(--pw-text-2)',
        }}
      >
        {view.label}
      </div>
      {round.feedHealth === 'DEGRADED' ? (
        // §23.6: say when the data is late. It is still real data, so the round
        // continues — but the player is told rather than left to wonder why the
        // frontline has stopped moving.
        <div style={{ ...captionStyle, color: 'var(--pw-warning)' }}>MARKET DATA DELAYED</div>
      ) : null}
    </div>
  );
}

const phaseStyle = {
  fontFamily: 'var(--pw-font-display)',
  letterSpacing: '0.08em',
  fontSize: 12,
} as const;

/**
 * The countdown to the next deadline (§3.2, §42.2).
 *
 * Projected from server time through the observed clock offset (§23.5), never
 * counted off the device clock. A player whose laptop is four minutes fast must
 * see the same lock time as everyone else.
 *
 * Ticks once a second rather than every frame: the display changes at one hertz,
 * and re-rendering the HUD sixty times a second to show the same two digits
 * spends frame budget §82 has other plans for.
 *
 * Renders nothing when the phase has no deadline. §25's finalization takes as
 * long as it takes, and a timer there would be a guess presented as a promise.
 */
export function Countdown(): JSX.Element | null {
  const round = useSession((state) => state.round);
  const clockOffsetMs = useSession((state) => state.clockOffsetMs);
  const now = useSecondTick();

  if (round === null) {
    return null;
  }

  const view = roundView(round.state, round.clock);
  if (view.countdownTarget === null || view.countdownCaption === null) {
    return null;
  }

  const remaining = view.countdownTarget - (now + clockOffsetMs);

  return (
    <div style={panelStyle}>
      <div style={captionStyle}>{view.countdownCaption}</div>
      {/*
        Tabular numerals so the countdown does not jitter as digits change
        (§36.12, design tokens §5). A player has one minute to decide (§3.1); a
        timer that shifts width under them is a small cruelty.
      */}
      <div className="pw-tabular" style={{ fontSize: 28, color: 'var(--pw-text-1)' }}>
        {formatCountdown(remaining)}
      </div>
    </div>
  );
}

/**
 * Local time, refreshed once a second.
 *
 * Aligned to the next whole second rather than set on a fixed interval from
 * mount, so the digit changes when the second changes instead of drifting a few
 * hundred milliseconds behind it.
 */
function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const schedule = (): void => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(schedule, 1_000 - (current % 1_000));
    };
    schedule();

    return () => {
      clearTimeout(timer);
    };
  }, []);

  return now;
}
