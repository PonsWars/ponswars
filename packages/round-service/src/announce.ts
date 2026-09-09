import { sectorIds, type RoundEngineState } from '@ponswars/battle-engine';
import { WORLD_CHANNEL } from '@ponswars/realtime';
import { roundOpenedPayloadSchema } from '@ponswars/schemas';
import type { PublisherPort } from './ports.js';

/**
 * Announcing a round that has just opened (§48.3 `ROUND_OPENED`).
 *
 * Deliberately not part of `stepRound`. The loop is handed a round that is
 * already open and drives it from there; nothing in it creates one, so nothing
 * in it can know that one has just been created. Whoever opens a round calls
 * this, once, and the separation is what keeps the loop free of a "have I
 * announced this yet?" flag it would have to persist.
 *
 * The payload is parsed on the way out through the same schema a client parses
 * it with on the way in. §66.2 asks for explicit schemas at ingress, and a
 * publisher that emitted an unvalidated payload would put the burden of that
 * contract entirely on the receiver.
 */
export async function announceRoundOpened(
  state: RoundEngineState,
  publisher: PublisherPort,
): Promise<void> {
  const sectors = sectorIds();

  const payload = roundOpenedPayloadSchema.parse({
    roundId: state.roundId,
    clock: state.clock,
    // The sector a battle occupies is its slot in the round (§38.4): five
    // fixed, neutral sectors reused every round. Positional rather than
    // stored, so it is derived here exactly as the API derives it.
    matchups: state.battles.map((battle, slot) => ({
      battleId: battle.setup.battleId,
      sectorId: sectors[slot] ?? sectors[0],
      left: battle.setup.left,
      right: battle.setup.right,
      leftIntel: battle.setup.leftIntel,
      rightIntel: battle.setup.rightIntel,
    })),
  });

  // On the world channel, and this is the only choice that works. §48.1 gives
  // a round its own channel, but nobody can subscribe to a round they have not
  // heard of — and this event *is* the hearing of it. Announcing a new round on
  // its own channel would deliver it to exactly the set of clients who already
  // knew, which is nobody.
  await publisher.publish('ROUND_OPENED', WORLD_CHANNEL, state.clock.pickOpenAt, payload);
}
