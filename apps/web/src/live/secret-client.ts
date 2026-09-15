import { apiErrorSchema, secretClaimSchema, type SecretClaim } from '@ponswars/schemas';
import type { LiveEndpoints } from './endpoints.js';
import type { ProfileFailure } from './profile-client.js';

/**
 * Reading what the Secret Stock Vault holds for the signed-in wallet (§8.5).
 *
 * Named failures, like every other private read: a Secret that did not load
 * must never read as a wallet that does not hold one.
 */

export type SecretClaimResult =
  | { readonly ok: true; readonly secret: SecretClaim }
  | { readonly ok: false; readonly failure: ProfileFailure };

export async function fetchSecretClaim(
  endpoints: LiveEndpoints,
  authorization: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SecretClaimResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}/v1/rewards/secret`, {
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

  const parsed = secretClaimSchema.safeParse(payload);
  return parsed.success
    ? { ok: true, secret: parsed.data }
    : {
        ok: false,
        failure: { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
      };
}
