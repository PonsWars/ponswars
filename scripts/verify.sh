#!/usr/bin/env bash
#
# Single quality gate. Every commit must pass this.
#
# `set -euo pipefail` matters here: piping a checker into `tail` to shorten its
# output discards the checker's exit status, which is how a failing lint run can
# slip into a commit unnoticed. Nothing in this script is piped.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Foundry installs to ~/.foundry/bin and is not always on PATH. Resolve it here
# rather than skipping the contract gate when it is missing: silently not
# testing the contracts that settle real value is worse than a failed run.
if ! command -v forge >/dev/null 2>&1; then
  if [ -x "$HOME/.foundry/bin/forge" ]; then
    export PATH="$HOME/.foundry/bin:$PATH"
  else
    echo "forge not found. Install Foundry from https://getfoundry.sh" >&2
    exit 1
  fi
fi

# First, because everything after it runs against whatever the dependency graph
# actually is. CI installs with --frozen-lockfile, so a lockfile that disagrees
# with a package.json fails there and nowhere else — which is how a green local
# run pushed a red build twice. `--lockfile-only` resolves without touching
# node_modules, so this costs well under a second.
step 'lockfile in sync'
pnpm install --frozen-lockfile --lockfile-only

step 'format'
npx prettier --check .

# Build before lint, and do not "tidy" this back.
#
# The lint config is type-aware (§66.1), and type-aware rules resolve workspace
# packages through their emitted declarations. On a fresh checkout `dist/` does
# not exist yet, every `@ponswars/*` import resolves to an error type, and the
# unsafe-* rules fire on almost every line — 1896 of them the first time CI ran
# this. Locally it passed only because a previous build had left the output
# behind, which is the worst kind of green: a gate that agrees with you because
# of a file nobody remembers creating.
step 'typecheck (build projects)'
npx tsc --build

step 'lint'
npx eslint .

step 'typecheck (test projects)'
npx tsc -p tsconfig.tests.json

# The web app is not part of `tsc --build`: it is a bundler-resolved,
# non-composite project, so it needs its own pass. Running the package's own
# build script rather than `tsc` alone means the gate checks the same command
# that produces a deployable bundle — a project that typechecks but fails to
# bundle is still broken.
step 'web app build'
pnpm --filter @ponswars/web build

step 'test'
npx vitest run --reporter=dot

step 'env contract in sync'
node scripts/generate-env-example.mjs --check

step 'migrations parse'
node scripts/check-migrations.mjs

step 'merkle fixture in sync'
node scripts/generate-merkle-fixture.mjs --check

step 'contracts build'
forge build

step 'contracts test'
forge test

printf '\n\033[32m✓ all gates passed\033[0m\n'
