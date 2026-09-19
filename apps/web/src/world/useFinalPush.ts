import { inFinalPush } from '../hud/round-phase.js';
import { useSecondTick } from '../hud/useSecondTick.js';
import { useSession } from '../state/session.js';

/**
 * Whether the world should be in its final push right now (§38.6, §13.5).
 *
 * §38.6: *Final Push — world lighting and intensity rise, with no score
 * mechanics change.* The HUD says it in words; the world says it in light, and
 * both read the same rule from the same clock — server time through the
 * observed offset (§23.5), never the device's own.
 *
 * Checked once a second, the rate the countdown changes at. The window is
 * thirty seconds long, and starting it a fraction of a second late costs
 * nothing a player can see; re-rendering the world every frame to find out
 * would.
 */
export function useFinalPush(): boolean {
  const round = useSession((state) => state.round);
  const clockOffsetMs = useSession((state) => state.clockOffsetMs);
  const now = useSecondTick();
  return round !== null && inFinalPush(round.state, round.clock, now + clockOffsetMs);
}
