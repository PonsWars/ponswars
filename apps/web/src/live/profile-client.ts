import { apiErrorSchema, profileSchema, type Profile } from '@ponswars/schemas';
import type { LiveEndpoints } from './endpoints.js';

/**
 * Reading the signed-in wallet's record (§69.9).
 *
 * The profile and the rewards hub both show it, and both are pages a player
 * checks their own standing on. So every way the read can fail comes back
 * named, as the pick client's do — a record that did not load must never be
 * shown as a record of nothing, which is what an empty profile would say.
 */

export type ProfileFailure =
  /** The request never completed. */
  | { readonly kind: 'UNREACHABLE'; readonly detail: string }
  /** The server refused, and said why (`UNAUTHENTICATED` when the session lapsed). */
  | {
      readonly kind: 'REFUSED';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly nextStep: string;
    }
  /** The server answered with something this client cannot read. */
  | { readonly kind: 'MALFORMED'; readonly detail: string };

export type ProfileResult =
  | { readonly ok: true; readonly profile: Profile }
  | { readonly ok: false; readonly failure: ProfileFailure };

export async function fetchProfile(
  endpoints: LiveEndpoints,
  authorization: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ProfileResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}/v1/profile`, {
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

  const parsed = profileSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      failure: { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
    };
  }
  return { ok: true, profile: parsed.data };
}
