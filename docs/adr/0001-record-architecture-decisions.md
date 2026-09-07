# 1. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-08
- **Milestone:** 0

## Context

The masterplan settles what PonsWars does. It deliberately leaves a set of
engineering choices open, and §6 of `START_HERE.md` is explicit about the
failure mode to avoid:

> If implementation pressure reveals a conflict, performance issue, or missing
> rule: identify it explicitly, propose the smallest compatible solution,
> preserve all locked mechanics where possible, mark any material rule change as
> requiring a Masterplan revision, **never silently replace the rule inside
> code**.

Without a record, an engineering decision made under pressure becomes
indistinguishable from a product rule a year later. That is exactly how a
locked mechanic gets quietly rewritten.

## Decision

Record every architectural decision as a numbered Markdown file in `docs/adr/`.

An ADR is required when a choice:

- affects more than one package or service,
- constrains what future work can do,
- resolves an ambiguity in the masterplan, or
- introduces a rule that is not in the masterplan.

An ADR is **not** a substitute for a masterplan revision. If a decision changes
a locked mechanic, the ADR records that a revision is required and the work
stops until it exists.

## Format

Context, Decision, Consequences. Short. Written when the decision is made, not
reconstructed afterwards. Superseded ADRs stay in place with a pointer forward —
the reasoning that was wrong is often more useful than the conclusion that
replaced it.

## Consequences

- Every non-obvious choice has a discoverable rationale.
- `docs/OPEN_PARAMETERS.md` gains a companion: that file tracks values still to
  be decided, ADRs record decisions already taken.
- Reviewers can tell a product rule from an engineering judgement by where it
  is written down.
