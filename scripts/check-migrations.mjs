#!/usr/bin/env node
/**
 * Parses every migration with the real PostgreSQL grammar.
 *
 * `pgsql-parser` wraps the actual server parser compiled to WebAssembly, so a
 * file that passes here is a file Postgres will accept — this is not a regex
 * approximation. It catches the class of mistake that otherwise surfaces only
 * when someone applies a migration to a live database.
 *
 * It does **not** check semantics. A reference to a table that does not exist,
 * or a type mismatch, still needs a real database; `pnpm run db:up` brings one
 * up under Docker for that. This script is the gate that runs everywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'database', 'migrations');

const { loadModule, parseSync } = await import('pgsql-parser');
await loadModule();

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migrations found in database/migrations');
  process.exit(1);
}

let statements = 0;
let failed = 0;

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  try {
    const parsed = parseSync(sql);
    const count = parsed?.stmts?.length ?? 0;
    statements += count;
    console.log(`  ok  ${file} (${String(count)} statements)`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL ${file}: ${message}`);
  }
}

// Every migration must be transactional. A partially applied migration leaves a
// schema nobody designed, and recovering from one by hand is exactly the
// situation to avoid at 3am.
for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  if (!/^\s*BEGIN;/m.test(sql) || !/^\s*COMMIT;/m.test(sql)) {
    failed += 1;
    console.error(`  FAIL ${file}: must be wrapped in BEGIN; ... COMMIT;`);
  }
}

// Sequential numbering with no gaps and no duplicates, so the apply order is
// unambiguous.
const numbers = files.map((name) => Number.parseInt(name.slice(0, 4), 10));
numbers.forEach((value, index) => {
  if (value !== index + 1) {
    failed += 1;
    console.error(`  FAIL ${files[index]}: expected sequence number ${String(index + 1)}`);
  }
});

if (failed > 0) {
  console.error(`\n${String(failed)} migration problem(s)`);
  process.exit(1);
}

console.log(`\n${String(files.length)} migrations, ${String(statements)} statements, all parse`);
