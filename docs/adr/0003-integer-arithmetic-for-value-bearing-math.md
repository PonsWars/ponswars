# 3. All value-bearing arithmetic is integer arithmetic

- **Status:** Accepted
- **Date:** 2026-09-08
- **Milestone:** 0

## Context

Two engineering standards constrain the numeric strategy:

- **§66.3** — never use JavaScript floating point for token amounts. Integer
  base units and `bigint` onchain; decimal formatting only at presentation.
- **§66.4** — battle scoring must use one documented deterministic numerical
  strategy across replay, production and tests.

§26 raises the bar further. The system must be able to answer _"why did this
stock win this specific round?"_ with reproducible evidence. Reproducible means
a replay run months later, possibly by a third party, possibly in another
language, arrives at the same result — bit for bit, not approximately.

Floating point breaks that in three separate places:

1. **Money.** `0.1 + 0.2 !== 0.3`. A reward calculated as a double and settled
   as an integer will disagree with itself somewhere.
2. **Aggregation.** Card support is summed across tens of thousands of players
   before the 10-point cap. Accumulated rounding error is small per addition and
   not small after fifty thousand of them.
3. **Roots.** Reward weight is `sqrt(WP)` (§16.5). `Math.sqrt` is only required
   to be correctly rounded for the double result; it is not a stable cross-
   language contract on a value that splits real SPY.

## Decision

No `number` carries a value that money or a result depends on.

- **Token amounts** are `BaseUnits` — a branded `bigint` of integer base units.
  Decimal strings are parsed with `parseDecimalToBaseUnits`, which runs entirely
  in `bigint` and **refuses** to truncate significant digits rather than
  silently dropping them.
- **Percentages** are basis points. The 80/20 pool split is `8000`/`2000`; the
  2% cap is `200`; Genesis rarity is `5000/2800/1400/600/190/10`. `1.9%` is not
  exactly representable as a double, `190` is, and the six rates sum to exactly
  `10000`.
- **Ratios** go through `mulDivFloor`, which multiplies before dividing and
  floors once. A distribution can never allocate more than the pool holds, and
  the flooring remainder carries forward (§16.7) rather than vanishing.
- **Square roots** use `integerSqrt`, Newton's method on `bigint`, with no
  floating point in the loop. Reward weight is `integerSqrt(wp × SCALE²)` at a
  fixed scale of `10⁹`.
- **Card support** is stored in integer tenths. The masterplan writes `+1.5`;
  the catalog stores `15`.

`number` remains correct for values that are not money and not part of a result:
market prices and volumes as sampled from a feed, normalized frontline position,
visual intensity. Typing a price as `BaseUnits` would imply a token precision it
does not have.

## Consequences

- Replay is exact by construction rather than by tolerance. There is no epsilon
  anywhere in the scoring or reward path.
- The strategy ports cleanly. An auditor reimplementing the allocation in
  Python or Solidity gets identical integers, because every operation is defined
  on integers.
- Arithmetic is more verbose. `mulDivFloor(pool, weight, totalWeight)` reads
  worse than `pool * weight / totalWeight`, and the catalog stores `15` where
  the masterplan says `1.5`. Tests carry the mapping back to the document so the
  translation is checked rather than remembered.
- `bigint` does not serialize to JSON. Boundaries convert explicitly, which is
  the right place for the decision anyway.
