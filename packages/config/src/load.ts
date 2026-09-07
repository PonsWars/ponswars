import {
  PARAMETER_NAMES,
  PARAMETERS,
  type Config,
  type ParameterName,
  type ParameterSpec,
} from './parameters.js';
import type { ParseResult } from './parsers.js';

/** One parameter that failed to load, with the reason. */
export interface ConfigIssue {
  readonly name: ParameterName;
  readonly reason: string;
}

/**
 * Raised when configuration is missing or invalid.
 *
 * Carries **every** issue rather than the first. An operator bringing up a new
 * environment should learn about all eleven missing variables in one run, not
 * discover them one restart at a time.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const detail = issues.map((issue) => `  ${issue.name}: ${issue.reason}`).join('\n');
    super(`Invalid configuration (${String(issues.length)} problem(s)):\n${detail}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Widens one entry of the parameter table to a uniform spec.
 *
 * `PARAMETERS[name]` is a union of differently-typed specs, and only some
 * declare `secret`. Widening once here keeps the loader reading a single shape
 * instead of narrowing the union at every access.
 */
function specOf(name: ParameterName): ParameterSpec<unknown> {
  return PARAMETERS[name];
}

function parseOne(name: ParameterName, env: Env): ParseResult<unknown> {
  const spec = specOf(name);
  const raw = env[name];

  if (raw === undefined) {
    return { ok: false, error: 'is required and was not set' };
  }
  return spec.parse(raw);
}

/**
 * Loads and validates the whole environment contract.
 *
 * Fails fast and completely (§65.2). Nothing is defaulted: a missing `OPEN`
 * parameter is an error, never a silently substituted value (§102).
 *
 * Failure messages quote the offending value so a typo is obvious, except for
 * parameters marked `secret`, whose values are redacted — §87 forbids logging
 * credentials, and an error message is a log line like any other.
 *
 * @throws ConfigError listing every problem found.
 */
export function loadConfig(env: Env): Config {
  const issues: ConfigIssue[] = [];
  const values: Partial<Record<ParameterName, unknown>> = {};

  for (const name of PARAMETER_NAMES) {
    const result = parseOne(name, env);
    if (result.ok) {
      values[name] = result.value;
      continue;
    }

    const raw = env[name];
    const shown =
      raw === undefined || specOf(name).secret === true
        ? result.error
        : `${result.error} (received ${JSON.stringify(raw)})`;
    issues.push({ name, reason: shown });
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return values as Config;
}

/**
 * Human-readable description of the environment contract.
 *
 * Used by `.env.example` generation and by operator tooling, so the list an
 * operator reads is generated from the same table the loader enforces and
 * cannot drift from it.
 */
export function describeParameters(): readonly {
  readonly name: ParameterName;
  readonly group: string;
  readonly description: string;
  readonly secret: boolean;
}[] {
  return PARAMETER_NAMES.map((name) => {
    const spec = specOf(name);
    return {
      name,
      group: spec.group,
      description: spec.description,
      secret: spec.secret === true,
    };
  });
}
