import { createContext } from 'react';

/**
 * What a formation knows about its own movement, for the things standing in it.
 *
 * Refs rather than React state, because both values change every frame and are
 * read only inside frame loops: a state update per frame would re-render an
 * entire army sixty times a second to move it a fraction of a unit.
 *
 * - `lean` is how far the formation has actually moved — eased, not the target —
 *   so fire leaving the front of it leaves from where the front really is.
 * - `moving` is whether it is moving fast enough to march. A unit reads it to
 *   decide between a walk and a stand; see `stanceFor` in `army-rules.ts`.
 */
export interface FormationMotion {
  readonly lean: { current: number };
  readonly moving: { current: boolean };
}

export const FormationContext = createContext<FormationMotion | null>(null);
