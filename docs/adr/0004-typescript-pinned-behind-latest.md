# 4. TypeScript is pinned to 6.0.x, behind the published latest

- **Status:** Accepted
- **Date:** 2026-09-08
- **Milestone:** 0

## Context

At scaffolding time the registry offered TypeScript `7.0.2` as `latest`, while
`typescript-eslint@8.70.0` — including its parser, which every type-aware lint
rule depends on — declared:

```
"peerDependencies": { "typescript": ">=4.8.4 <6.1.0" }
```

Installing TypeScript 7 would satisfy the compiler and break the linter's type
information. The failure mode matters: type-aware rules do not error loudly when
they lose type data, they degrade. `no-unsafe-assignment`, `no-unsafe-return`
and `no-unsafe-argument` simply stop finding anything, and standard §66.1 — no
`any` at a production boundary — quietly becomes unenforced.

## Decision

Pin TypeScript to `^6.0.3`: the newest release the whole toolchain agrees on.

`@types/node` tracks `22.x` rather than the published `26.x` for the same class
of reason — the runtime is Node 22, and types describing Node 26 APIs would let
code compile against functions this runtime does not have.

Revisit when `typescript-eslint` widens its peer range. This is a temporary pin
on a moving target, not a preference for older tooling.

## Consequences

- Type-aware linting keeps full type information, so §66.1 stays enforced rather
  than nominally configured.
- The repository is one major version behind on the compiler and will need a
  deliberate upgrade pass rather than a version bump.
- `pnpm install` prints an available-update notice for both packages. That is
  expected; this ADR is the answer to "why not just upgrade".
