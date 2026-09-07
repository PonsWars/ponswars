# 5. Battle score components split on a clamped linear edge

- **Status:** Accepted
- **Date:** 2026-09-08
- **Milestone:** 1

## Context

§12 locks the _structure_ of the battle score and leaves the constants inside it
open:

- 45 / 25 / 20 / 10, summing to 100, with no component stealing weight
- price momentum volatility-adjusted against the asset's own recent volatility
- relative volume as a ratio against an expected baseline, never raw volume
- Pons power composed 70 / 30 with diminishing contribution
- card support capped at 10 points with diminishing returns

What §12 does not say is **how a component's weight is divided between two
sides** once each side's input is known. It gives the properties the division
must have — both sides can be negative and the relatively stronger still wins
(§12.1), one whale cannot linearly dominate (§12.3), four times the card support
is not four times the influence (§12.4) — but not the function.

That gap has to be filled to write the engine, and §59.2 confirms the choice
belongs to calibration rather than to product policy.

## Decision

Every component reduces to one signed **edge** and every edge is split by one
primitive.

```
edge  = clamp((strengthLeft − strengthRight) / divisor, −1, +1)
left  = weight × (1 + edge) / 2
right = weight − left
```

Four properties follow, and each is tested:

1. **The split is exact.** `right` is `weight − left`, not a second division, so
   the two halves sum to exactly the component weight for every input and the
   four components sum to exactly 100 points with no rounding drift.
2. **It is bounded.** Clamping means a component can never allocate more than
   its weight, whatever an input does.
3. **It is signed.** A negative edge is simply the mirror of a positive one, so
   two falling assets are compared on relative strength exactly as two rising
   ones are (§12.1).
4. **Zero signal is a tie.** Equal strengths give a zero edge and an even split,
   rather than a win for whichever side the arithmetic reaches first.

### Why linear and clamped rather than a logistic curve

A logistic or `tanh` curve is the more usual choice and would give a softer
saturation. It was rejected for one reason: **`tanh` is transcendental.**

§26 requires a replay — months later, possibly by a third party, possibly in
another language — to reproduce a result exactly. A transcendental function does
not have a single answer across implementations; it has an answer per libm. Two
correct implementations can disagree in the last bits, and near a component
boundary those bits decide a battle.

The clamped linear map is exact in integer arithmetic, specifiable in one line,
and reproducible from `bigint` division alone. The cost is a harder shoulder at
saturation, which is a presentation difference, not a fairness one.

### Where the divisors come from

`ScoringCalibration` is an **input** to `scoreBattle`, never a compiled default.
The divisor is the edge at which a component saturates — with a price divisor of
`2.0`, a two-sigma advantage in volatility-adjusted return takes all 45 points.
Those values are `CALIBRATE` in `docs/OPEN_PARAMETERS.md`, and §102 forbids
shipping one as product policy. The test suite uses its own calibration
explicitly labelled as such.

### Diminishing transforms

Pons counts and card support pass through `integerSqrt` before the edge. A
square root is the diminishing transform that costs nothing in determinism — it
is exact `bigint`, unlike a logarithm. Card support additionally spreads General
across the three scoring channels in proportion to the base battle weighting,
then recombines under that same weighting, which is what §12.4 means by
_"channel emphasis should broadly follow the base battle weighting"_.

## Consequences

- The engine is one primitive plus four edge derivations, so a reviewer checks
  the split once rather than four times.
- Recalibration is a configuration change, not a code change.
- Edges are retained on the result as §26 evidence. They are the intermediate
  step that explains a split, so _"why did this stock win?"_ is answered from
  the record instead of recomputed.
- Saturation is abrupt at the clamp. If play shows that to be a problem, the
  fix is a smaller divisor or a piecewise-linear curve with more segments —
  both still exact. Reintroducing a transcendental would trade reproducibility
  for smoothness, and reproducibility is the requirement.
- Independent flooring means derived relationships hold to within one scaled
  unit, not exactly. Tests assert the guarantee the arithmetic actually makes.
