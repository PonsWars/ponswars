import { apiErrorSchema } from '@ponswars/schemas';
import { ROBINHOOD_CHAIN_MAINNET_ID } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import * as errors from './errors.js';
import type { ErrorResponse } from './errors.js';

/**
 * What the API says when it refuses (§110.5, §47).
 *
 * §110.5 asks an error for three things: what happened, whether the player's
 * state and funds are safe, and what they can do next. The schema makes the
 * fields required; it cannot make the answers true. These tests hold the file
 * to the harder half — that every refusal names a step the player can take,
 * and that the ones a player will actually hit say plainly that nothing was
 * spent.
 */

const CORRELATION = 'corr-0123456789';

/** Every error this API can return, each with arguments a caller would pass. */
const EVERY: readonly (readonly [string, ErrorResponse])[] = [
  ['invalidRequest', errors.invalidRequest('ticker: expected one of ten', CORRELATION)],
  ['roundNotFound', errors.roundNotFound('round-0000000042', CORRELATION)],
  ['marketClosed', errors.marketClosed(Date.parse('2026-09-28T13:30:00Z'), CORRELATION)],
  ['picksClosed', errors.picksClosed(CORRELATION)],
  ['battleNotInRound', errors.battleNotInRound('round-42-b3', CORRELATION)],
  ['tickerNotInBattle', errors.tickerNotInBattle('GME', CORRELATION)],
  ['alreadyPicked', errors.alreadyPicked(CORRELATION)],
  ['resultNotFound', errors.resultNotFound('round-42-b3', CORRELATION)],
  ['battleVoided', errors.battleVoided('round-42-b3', 'DATA_INTEGRITY', CORRELATION)],
  ['noPickToDecide', errors.noPickToDecide(CORRELATION)],
  ['noCardToUse', errors.noCardToUse(CORRELATION)],
  ['unauthenticated', errors.unauthenticated(CORRELATION)],
  ['tooManyRequests', errors.tooManyRequests(Date.parse('2026-09-23T10:00:00Z'), CORRELATION)],
  ['genesisUnavailable', errors.genesisUnavailable(CORRELATION)],
  ['chainUnavailable', errors.chainUnavailable(CORRELATION)],
  ['genesisRequestNotFound', errors.genesisRequestNotFound(CORRELATION)],
  ['signInRefused', errors.signInRefused(CORRELATION)],
  ['wrongChain', errors.wrongChain(ROBINHOOD_CHAIN_MAINNET_ID, CORRELATION)],
];

describe('every error the API can return', () => {
  it('is one this test knows about', () => {
    // A new error added without a line in `EVERY` is a new sentence to a
    // player that nothing here has read.
    const exported = Object.entries(errors)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(exported).toEqual(EVERY.map(([name]) => name).sort());
  });

  it.each(EVERY)('%s answers §110.5 in full', (_name, response) => {
    const body = apiErrorSchema.parse(response.body);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);
    // A code a client can branch on, and a message a person can read.
    expect(body.code).toMatch(/^[A-Z][A-Z_]+$/);
    expect(body.message.length).toBeGreaterThan(12);
    // The step: never blank, and never the message again.
    expect(body.nextStep.length).toBeGreaterThan(12);
    expect(body.nextStep).not.toBe(body.message);
    expect(body.correlationId).toBe(CORRELATION);
  });

  it('never leaves a player wondering whether something was spent', () => {
    // Nothing this API refuses has taken anything: a pick after lock, a card
    // decision with no pick, a signature that did not match. Each says so,
    // because §110.5's second question is the one a player asks first.
    for (const [, response] of EVERY) {
      expect(response.body.stateIsSafe).toBe(true);
    }
  });
});

describe('the errors a player is most likely to see', () => {
  it('tells a voided battle it cost nothing and gave the card use back (§110.6)', () => {
    const integrity = errors.battleVoided('round-42-b3', 'DATA_INTEGRITY', CORRELATION);
    const halted = errors.battleVoided('round-42-b3', 'MARKET_HALT', CORRELATION);

    expect(integrity.body.message).toContain('integrity');
    expect(halted.body.message).toContain('halted');
    for (const response of [integrity, halted]) {
      expect(response.status).toBe(404);
      expect(response.body.nextStep).toContain('restored');
    }
  });

  it('gives a rate-limited caller the instant to come back, not a guess', () => {
    const retryAt = Date.parse('2026-09-23T10:00:00Z');
    const response = errors.tooManyRequests(retryAt, CORRELATION);

    expect(response.status).toBe(429);
    expect(response.body.retryAt).toBe(retryAt);
    // In the sentence too, so a client that shows the message is not lying
    // about when the wait ends.
    expect(response.body.nextStep).toContain(new Date(retryAt).toISOString());
  });

  it('names the chain a wallet must switch to, and its id', () => {
    const response = errors.wrongChain(ROBINHOOD_CHAIN_MAINNET_ID, CORRELATION);

    // Both: the name is what a person reads, the id is what a wallet's network
    // list shows them.
    expect(response.body.nextStep).toContain('Robinhood');
    expect(response.body.nextStep).toContain(String(ROBINHOOD_CHAIN_MAINNET_ID));
  });

  it('says a wallet is needed without suggesting one is needed to watch (§5)', () => {
    const response = errors.unauthenticated(CORRELATION);

    expect(response.status).toBe(401);
    expect(response.body.nextStep.toLowerCase()).toContain('watching needs no wallet');
  });
});
