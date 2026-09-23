# 8. Launch with a fifteen-minute price staleness bound

- **Status:** Accepted
- **Date:** 2026-09-24
- **Decided by:** the founder

## Context

`PRICE_FEED_STALE_AFTER_MS` is how long a Stock Token's last trade may stand in
for its price before the feed is `STALE`, and a `STALE` feed voids the live
battle (§23.6, §4.4). It is registered `OPEN` because it decides which battles
are played at all, which is product policy and not tuning (§102).

What the recorded tapes say, replayed through the market adapter and the engine
with every other value at `tools/calibration/initial-candidate.json`:

| Bound      | Battles voided | Tapes                                                      |
| ---------- | -------------- | ---------------------------------------------------------- |
| 15 minutes | 35.7%          | 2026-09-15 to 2026-09-23: 545 rounds, 24,525 battles       |
| 15 minutes | 34.1%          | 2026-09-15 to 2026-09-21 (`OPEN_PARAMETERS.md`, first run) |
| 30 minutes | 16.3%          | 2026-09-15 to 2026-09-21                                   |

Almost every void comes from four tickers whose market on Robinhood Chain is
thin. In the nine-day replay, the battles each ticker voided through its own
data: GME 2,574, AMZN 2,410, AMD 2,050, MSFT 1,360 — against 0 for SPY, 18 for
META, 21 for NVDA and 33 for AAPL. The liquid six are voided at about 22% only
because they are paired with the thin four.

A longer bound halves the voids by deciding more battles on a price carried
forward from an older trade. On the thin tickers that is a price a few dollars
of trading can set — GME traded about $640 an hour over the first week, with a
median trade of $10 — and a battle decided on it pays War Points, which are a
share of real SPY (§16).

## Decision

**`PRICE_FEED_STALE_AFTER_MS=900000`** — fifteen minutes — for launch.

A void is the game's fail-safe: the battle is not scored and the player's card
use is restored (§4.4, §110.6). It costs the player a battle. A battle decided
on a price one small trade could have set costs every other player a share of
the pool. With real SPY at stake and the contracts not yet independently
reviewed, the launch takes the cost that falls on nobody's rewards.

## Consequences

- **About one battle in three voids at launch**, most of them involving GME,
  AMZN, AMD or MSFT. Players should hear this from the game before they meet
  it: the void message says the card use was restored, and nothing should
  suggest a voided battle was lost.
- **The bound is revisited on a clean week of tapes** — seven days each at
  least 95% recorded (`pnpm run tape:coverage`), expected around 2026-09-30 —
  and when the thin markets deepen. Loosening it is a new decision with its own
  record, not a tuning change.
- **Only this bound is decided.** `VOLUME_FEED_STALE_AFTER_MS`,
  `PONS_FEED_STALE_AFTER_MS` and the other market guards are not settled by
  this record. The replay above measured them at the candidate's values, and
  they stay `CALIBRATE` in the registry until they are chosen.
