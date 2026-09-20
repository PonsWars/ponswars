import { existsSync } from 'node:fs';
import { utcTimestamp, type RoundState } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  lifecycle,
  reconcile,
  stuckRound,
  uncoveredVault,
  voidedBattles,
  type Condition,
} from './alerts.js';

/**
 * What is worth waking someone for (§59.3).
 */

const END = 1_800_000_600_000;
const MINUTE = 60_000;

const round = (state: RoundState) => ({
  roundId: 'round-0000000042',
  state,
  clock: { battleEndAt: utcTimestamp(END) },
});

describe('a stuck round', () => {
  it('is reported once it is later than the deployment allows', () => {
    const condition = stuckRound(round('FINALIZING'), utcTimestamp(END + 11 * MINUTE), 10 * MINUTE);

    expect(condition?.severity).toBe('CRITICAL');
    expect(condition?.title).toContain('round-0000000042');
    expect(condition?.detail).toContain('11 minutes');
  });

  it('is not reported inside the allowance', () => {
    // A chain-derived tiebreak waits on a finalized block (§12.7): late is
    // not the same as stuck until the deployment says so.
    expect(
      stuckRound(round('FINALIZING'), utcTimestamp(END + 10 * MINUTE), 10 * MINUTE),
    ).toBeNull();
  });

  it('is never reported for a round that has finished, however late', () => {
    for (const state of ['FINALIZED', 'VOID'] as const) {
      expect(stuckRound(round(state), utcTimestamp(END + 60 * MINUTE), MINUTE)).toBeNull();
    }
  });

  it('covers a round still live past its cutoff as well as one finalizing', () => {
    // The runbook's two cases: finalization not attempted, and blocked.
    expect(stuckRound(round('BATTLE_LIVE'), utcTimestamp(END + 2 * MINUTE), MINUTE)).not.toBeNull();
    expect(stuckRound(round('FINALIZING'), utcTimestamp(END + 2 * MINUTE), MINUTE)).not.toBeNull();
  });

  it('has nothing to say before there is a round', () => {
    expect(stuckRound(null, utcTimestamp(END), MINUTE)).toBeNull();
  });

  it('points at a runbook that exists', () => {
    const condition = stuckRound(round('FINALIZING'), utcTimestamp(END + 2 * MINUTE), MINUTE);
    expect(existsSync(new URL(`../../../${condition?.runbook ?? ''}`, import.meta.url))).toBe(true);
  });
});

describe('the Secret vault', () => {
  it('is reported when it cannot cover another Secret (§8.3)', () => {
    expect(uncoveredVault(false)?.severity).toBe('WARNING');
  });

  it('is quiet when covered, and when this deployment reserves nothing', () => {
    // Secrets off by decision are not an alert.
    expect(uncoveredVault(true)).toBeNull();
    expect(uncoveredVault(null)).toBeNull();
  });
});

describe('voided battles', () => {
  it('names each one, and says the card uses came back (§110.6)', () => {
    const notice = voidedBattles('round-7', ['battle-a', 'battle-b']);

    expect(notice?.status).toBe('NOTICE');
    expect(notice?.title).toBe('2 battles voided in round-7');
    expect(notice?.detail).toContain('battle-a, battle-b');
    expect(notice?.detail).toContain('restored');
  });

  it('says nothing about a round that voided none', () => {
    expect(voidedBattles('round-7', [])).toBeNull();
  });
});

describe('the server itself', () => {
  it('says it started, quietly, and that it failed, loudly', () => {
    // A run of starts is a crash loop; a failure is somebody's night.
    expect(lifecycle('STARTED', 'chain 46630').severity).toBe('INFO');
    expect(lifecycle('FAILED', 'store unreachable').severity).toBe('CRITICAL');
  });
});

describe('reconciling what is wrong now against what was reported', () => {
  const stuck: Condition = {
    key: 'round-stuck:r1',
    severity: 'CRITICAL',
    title: 'stuck',
    detail: 'late',
    runbook: null,
  };
  const vault: Condition = {
    key: 'secret-vault-uncovered',
    severity: 'WARNING',
    title: 'vault',
    detail: 'empty',
    runbook: null,
  };

  it('sends a condition once, when it starts', () => {
    const first = reconcile(new Map(), [stuck]);
    expect(first.messages).toEqual([{ ...stuck, status: 'FIRING' }]);

    // Still wrong on the next evaluation: nothing new to say.
    const second = reconcile(first.active, [stuck]);
    expect(second.messages).toEqual([]);
  });

  it('says so once it clears', () => {
    const firing = reconcile(new Map(), [stuck, vault]);
    const cleared = reconcile(firing.active, [vault]);

    expect(cleared.messages).toEqual([{ ...stuck, status: 'RESOLVED' }]);
    expect([...cleared.active.keys()]).toEqual(['secret-vault-uncovered']);
  });

  it('reports a condition that comes back as a new one', () => {
    const firing = reconcile(new Map(), [vault]);
    const cleared = reconcile(firing.active, []);
    const back = reconcile(cleared.active, [vault]);

    expect(back.messages).toEqual([{ ...vault, status: 'FIRING' }]);
  });

  it('counts a condition once however many times it is listed', () => {
    expect(reconcile(new Map(), [stuck, stuck]).messages).toHaveLength(1);
  });
});
