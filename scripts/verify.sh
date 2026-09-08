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

step 'format'
npx prettier --check .

step 'lint'
npx eslint .

step 'typecheck (build projects)'
npx tsc --build

step 'typecheck (test projects)'
npx tsc -p tsconfig.tests.json

step 'test'
npx vitest run --reporter=dot

step 'env contract in sync'
node scripts/generate-env-example.mjs --check

step 'migrations parse'
node scripts/check-migrations.mjs

step 'contracts build'
forge build

step 'contracts test'
forge test

printf '\n\033[32m✓ all gates passed\033[0m\n'
