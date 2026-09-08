import type { ActiveTicker, ConfidenceLabel, MomentumState } from '@ponswars/shared-types';
import {
  advance,
  flyTo,
  focusMyWar,
  hudBudgetFor,
  initialCamera,
  resetView,
  zoomLevelForMode,
  type CameraConfig,
  type CameraState,
  type HudBudget,
  type QualityTier,
  type ZoomLevel,
} from '@ponswars/world-runtime';
import { durations } from '@ponswars/ui-tokens';
import { milliseconds, utcTimestamp, type UtcTimestamp } from '@ponswars/shared-types';
import { create } from 'zustand';
import {
  battlefieldPose,
  cinematicPose,
  GLOBAL_ANCHOR,
  sectorPose,
  WORLD_BOUNDARY_RADIUS,
} from '../world/layout.js';

/**
 * Transient client session state (§80.2).
 *
 * *"Use Zustand only for transient client/session interaction state such as:
 * selected battle, camera focus target, open panel, local performance mode,
 * audio preference, pending visual transition."*
 *
 * Nothing authoritative lives here. Round state, scores and results arrive from
 * the server through TanStack Query and the realtime reducer; duplicating them
 * into a second store without clear synchronisation is what §80.2 warns
 * against, and it is how a client ends up rendering a battle the server has
 * already finalized.
 */

/** A battle as the client knows it. Presentation fields only. */
export interface ClientBattle {
  readonly battleId: string;
  readonly sectorIndex: number;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  readonly leftConfidence: ConfidenceLabel;
  readonly rightConfidence: ConfidenceLabel;
  /**
   * Latest momentum from `BATTLE_STATE_UPDATE`.
   *
   * There is no score field, and there must never be one: §24 and §48.3 keep it
   * hidden for the whole live battle, and a field here is a field a component
   * will eventually render.
   */
  readonly momentum: MomentumState;
  readonly frontline: number;
}

interface SessionState {
  readonly camera: CameraState;
  readonly cameraConfig: CameraConfig;
  readonly battles: readonly ClientBattle[];
  /** The player's own battle this round, if they picked (§37.7 FOCUS MY WAR). */
  readonly myBattleId: string | null;
  readonly quality: QualityTier;
  readonly reducedMotion: boolean;

  setBattles: (battles: readonly ClientBattle[]) => void;
  setMyBattle: (battleId: string | null) => void;
  setQuality: (tier: QualityTier) => void;
  setReducedMotion: (reduced: boolean) => void;

  tick: (at: UtcTimestamp) => void;
  focusSector: (index: number, at: UtcTimestamp) => void;
  enterBattlefield: (index: number, at: UtcTimestamp) => void;
  playCinematic: (index: number, at: UtcTimestamp) => void;
  focusMyWar: (at: UtcTimestamp) => void;
  resetView: (at: UtcTimestamp) => void;
}

function configFor(reducedMotion: boolean): CameraConfig {
  const timing = durations(reducedMotion);
  return {
    globalAnchor: GLOBAL_ANCHOR,
    boundaryRadius: WORLD_BOUNDARY_RADIUS,
    durations: {
      // Timing classes come from the design tokens, not from numbers typed
      // here. Design tokens §1 forbids scattering animation timings through
      // components, and a camera duration is an animation timing.
      panelTransition: milliseconds(timing.panel),
      spatialTransition: milliseconds(timing.spatial),
      cinematic: milliseconds(timing.cinematic),
    },
    reducedMotion,
  };
}

export const useSession = create<SessionState>((set, get) => ({
  camera: initialCamera(configFor(false)),
  cameraConfig: configFor(false),
  battles: [],
  myBattleId: null,
  quality: 'BALANCED',
  reducedMotion: false,

  setBattles: (battles) => {
    set({ battles });
  },

  setMyBattle: (battleId) => {
    set({ myBattleId: battleId });
  },

  setQuality: (quality) => {
    set({ quality });
  },

  setReducedMotion: (reducedMotion) => {
    // Rebuilding the config rather than patching it keeps the camera and the
    // stylesheet reading the same durations (§15, §83.3).
    set({ reducedMotion, cameraConfig: configFor(reducedMotion) });
  },

  tick: (at) => {
    const { camera, cameraConfig } = get();
    const next = advance(camera, at, cameraConfig);
    // Reference equality when nothing moved, so a still camera does not
    // re-render the tree sixty times a second.
    if (next !== camera) {
      set({ camera: next });
    }
  },

  focusSector: (index, at) => {
    const { camera, cameraConfig, battles } = get();
    const battle = battles[index];
    set({
      camera: flyTo(
        camera,
        {
          to: sectorPose(index),
          mode: 'SECTOR_FOCUS',
          at,
          duration: cameraConfig.durations.spatialTransition,
          battleId: battle?.battleId ?? null,
        },
        cameraConfig,
      ),
    });
  },

  enterBattlefield: (index, at) => {
    const { camera, cameraConfig, battles } = get();
    const battle = battles[index];
    set({
      camera: flyTo(
        camera,
        {
          to: battlefieldPose(index),
          mode: 'BATTLE_TACTICAL',
          at,
          duration: cameraConfig.durations.spatialTransition,
          battleId: battle?.battleId ?? null,
        },
        cameraConfig,
      ),
    });
  },

  playCinematic: (index, at) => {
    const { camera, cameraConfig } = get();
    set({
      camera: flyTo(
        camera,
        {
          to: cinematicPose(index),
          mode: 'CINEMATIC_TEMP',
          at,
          duration: cameraConfig.durations.cinematic,
          // §81.3: a cinematic reduces control briefly. It carries its own
          // return leg so control comes back without anyone remembering.
          interruptible: false,
          restoreTo: battlefieldPose(index),
          restoreMode: 'BATTLE_TACTICAL',
        },
        cameraConfig,
      ),
    });
  },

  focusMyWar: (at) => {
    const { camera, cameraConfig, battles, myBattleId } = get();
    if (myBattleId === null) {
      return;
    }
    const index = battles.findIndex((battle) => battle.battleId === myBattleId);
    if (index < 0) {
      return;
    }
    set({ camera: focusMyWar(camera, myBattleId, sectorPose(index), at, cameraConfig) });
  },

  resetView: (at) => {
    const { camera, cameraConfig } = get();
    set({ camera: resetView(camera, at, cameraConfig) });
  },
}));

/**
 * The current instant, as a checked UTC timestamp.
 *
 * §23.5 keeps the client clock non-authoritative — this drives camera
 * interpolation and nothing else. A round countdown projects from server time
 * through the realtime clock offset, never from here.
 */
export function nowUtc(): UtcTimestamp {
  return utcTimestamp(Date.now());
}

/** The current spatial level (§37.2). */
export function currentZoom(state: Pick<SessionState, 'camera'>): ZoomLevel {
  return zoomLevelForMode(state.camera.mode);
}

/** What the HUD may show right now (§37.6). */
export function currentHudBudget(state: Pick<SessionState, 'camera'>): HudBudget {
  return hudBudgetFor(currentZoom(state));
}
