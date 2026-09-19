import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Color, type Vector3 } from 'three';
import { useSession } from '../state/session.js';
import { SECTOR_POSITIONS } from './layout.js';
import { afterglow, sectorGlows, weatherBurn } from './sector-glow.js';
import { useFinalPush } from './useFinalPush.js';

/**
 * The light the five sectors throw into the weather, written into a shader's
 * uniforms (§38.6, §38.10, §36.14).
 *
 * One hook for every layer of weather, because the rule is one rule: the deck
 * below and the banks beside the islands disagreeing about which faction is
 * pushing, or which phase the round is in, would be a sky in two moods. It
 * used to be written out twice.
 *
 * Two ways of writing, for two kinds of change:
 *
 * - **The steady light** changes when a battle's momentum or frontline does —
 *   about once a second (§23.1) — or when the round changes phase. An effect,
 *   because writing five vectors sixty times a second to say the same thing
 *   would be work for nothing.
 * - **The afterglow** fades continuously for a few seconds after a round
 *   finalizes. A frame hook, and only while it lasts: the moment it passes,
 *   the steady light is written back and the hook goes quiet again.
 *
 * `Vector3` and `Color` are mutated in place rather than replaced, because
 * three reads the same objects it was handed when the shader compiled.
 */

export interface SectorLightUniforms {
  /** Per sector: world x, world z, and how hard it burns. */
  readonly where: readonly Vector3[];
  readonly colour: readonly Color[];
}

const SCRATCH = new Color();

export function useSectorLight(targets: readonly SectorLightUniforms[]): void {
  const battles = useSession((state) => state.battles);
  const roundState = useSession((state) => state.round?.state ?? null);
  const pushing = useFinalPush();
  // Whether the last frame was drawing an afterglow, so the frame after it
  // ends puts the steady light back rather than leaving the fade's last step.
  const glowing = useRef(false);

  const writeSteady = (): void => {
    const glows = sectorGlows(battles, SECTOR_POSITIONS);
    const burning = weatherBurn(roundState, pushing);
    for (const { where, colour } of targets) {
      // Every slot dark first. A sector with no battle in it throws nothing,
      // rather than keeping the last battle's colour into the next round.
      for (const slot of where) {
        slot.set(0, 0, 0);
      }
      for (const glow of glows) {
        where[glow.sectorIndex]?.set(glow.x, glow.z, glow.strength * burning);
        const tint = colour[glow.sectorIndex];
        // Mixed by the frontline: the side holding more of the field puts more
        // of its colour in the cloud (§13.2).
        tint?.set(glow.left).lerp(SCRATCH.set(glow.right), 1 - glow.hold);
      }
    }
  };

  // The steady light. Re-run whenever anything it reads changes; it is cheap,
  // and a stale uniform is a sky that lies about the battle under it.
  useEffect(writeSteady);

  useFrame(() => {
    const { lastVictory, clockOffsetMs } = useSession.getState();
    const glows = afterglow(lastVictory, SECTOR_POSITIONS, Date.now() + clockOffsetMs);
    if (glows === null) {
      if (glowing.current) {
        glowing.current = false;
        writeSteady();
      }
      return;
    }
    glowing.current = true;
    // The winners' sectors take the winner's light; the rest keep what the new
    // round gives them. §38.6 makes the dominance the winner's, not the world's.
    for (const glow of glows) {
      for (const { where, colour } of targets) {
        where[glow.sectorIndex]?.set(glow.x, glow.z, glow.strength * glow.burn);
        colour[glow.sectorIndex]?.set(glow.left);
      }
    }
  });
}
