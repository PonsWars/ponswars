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

printf '\n\033[32m✓ all gates passed\033[0m\n'
