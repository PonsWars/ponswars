import { apiErrorSchema, rewardClaimsSchema, type RewardClaims } from '@ponswars/schemas';
import type { LiveEndpoints } from './endpoints.js';
import type { ProfileFailure } from './profile-client.js';

/**
 * Reading the signed-in wallet's published reward claims (§17, §35.6).
 *
 * Failures come back named, as a profile's do: claims that did not load must
 * never read as a wallet with nothing to claim.
 */

export type RewardClaimsResult =
  | { readonly ok: true; readonly claims: RewardClaims }
  | { readonly ok: false; readonly failure: ProfileFailure };

export async function fetchRewardClaims(
  endpoints: LiveEndpoints,
  authorization: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<RewardClaimsResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}/v1/rewards/claims`, {
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

  const parsed = rewardClaimsSchema.safeParse(payload);
  return parsed.success
    ? { ok: true, claims: parsed.data }
    : {
        ok: false,
        failure: { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
      };
}
