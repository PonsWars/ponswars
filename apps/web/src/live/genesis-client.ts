import { apiErrorSchema, genesisStatusSchema, type GenesisStatusBody } from '@ponswars/schemas';
import type { LiveEndpoints } from './endpoints.js';
import type { ProfileFailure } from './profile-client.js';

/**
 * Asking the server for a Genesis card, and where the claim has got to (§69.6).
 *
 * Two calls: `GET /v1/genesis` reads the claim — and finishes it on the server
 * once its Robinhood Chain block is final — and `POST /v1/genesis/request` asks
 * for one. Failures come back named, the way a profile's do: a claim that did
 * not load must never read as a wallet with no claim.
 */

export type GenesisResult =
  | { readonly ok: true; readonly status: GenesisStatusBody }
  | { readonly ok: false; readonly failure: ProfileFailure };

export function fetchGenesis(
  endpoints: LiveEndpoints,
  authorization: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GenesisResult> {
  return call(`${endpoints.api}/v1/genesis`, 'GET', authorization, signal, fetchImpl);
}

/** Idempotent: a wallet has one request, however many times this is sent. */
export function requestGenesis(
  endpoints: LiveEndpoints,
  authorization: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GenesisResult> {
  return call(`${endpoints.api}/v1/genesis/request`, 'POST', authorization, signal, fetchImpl);
}

async function call(
  url: string,
  method: 'GET' | 'POST',
  authorization: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<GenesisResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', authorization },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'UNREACHABLE', detail: String(error) } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'MALFORMED', detail: String(error) } };
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    return {
      ok: false,
      failure: parsed.success
        ? {
            kind: 'REFUSED',
            status: response.status,
            code: parsed.data.code,
            message: parsed.data.message,
            nextStep: parsed.data.nextStep,
          }
        : { kind: 'MALFORMED', detail: 'unreadable error body' },
    };
  }

  const parsed = genesisStatusSchema.safeParse(payload);
  return parsed.success
    ? { ok: true, status: parsed.data }
    : {
        ok: false,
        failure: { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
      };
}
