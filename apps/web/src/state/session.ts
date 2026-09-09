import type {
  ActiveTicker,
  CanonicalClock,
  CardDecision,
  ConfidenceSnapshot,
  FinalizedBattleResult,
  MomentumState,
  PublicFeedHealth,
  RoundState,
} from '@ponswars/shared-types';
import type { CardHolding } from '../hud/pick-flow.js';
import type { ConnectionState } from '../hud/round-phase.js';
import {
  advance,
  applyDrift,
  beginPan,
  endPan,
  flyTo,
  focusMyWar,
  hudBudgetFor,
  IDLE_NAVIGATION,
  initialCamera,
  panTo,
  pinchTo,
  resetView,
  stepOutward,
  zoomByNotches,
  zoomLevelForMode,
  type CameraConfig,
  type CameraMode,
  type CameraState,
  type HudBudget,
  type NavigationConfig,
  type NavigationState,
  type PointerSample,
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
  poseForMode,
  PRESENTATION_ANCHOR,
  sectorPose,
  WORLD_BOUNDARY_RADIUS,
} from '../world/layout.js';
import { NAVIGATION } from '../world/navigation-config.js';

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

/**
 * What the player has committed to in one battle (§22, §42.6).
 *
 * Server-confirmed. A pick becomes real when the round state says so, never
 * when the button was pressed — §22 makes the lock authoritative, and a client
 * that shows its own optimistic guess as settled is how a player believes they
 * are in a war they never entered.
 */
export interface Backing {
  readonly ticker: ActiveTicker;
  readonly cardDeployed: boolean;
}

/** A battle as the client knows it. Presentation fields only. */
export interface ClientBattle {
  readonly battleId: string;
  readonly sectorIndex: number;
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
  /**
   * Pre-battle intel for each side (§27.5, §42.4).
   *
   * A `ConfidenceSnapshot` and not a number: §10.2 gives the client a label and
   * four qualitative sub-signals, and deliberately no percentage. Carrying the
   * snapshot whole means a panel cannot render a confidence it computed itself.
   */
  readonly leftIntel: ConfidenceSnapshot;
  readonly rightIntel: ConfidenceSnapshot;
  /**
   * Latest momentum from `BATTLE_STATE_UPDATE`.
   *
   * There is no score field, and there must never be one: §24 and §48.3 keep it
   * hidden for the whole live battle, and a field here is a field a component
   * will eventually render.
   */
  readonly momentum: MomentumState;
  readonly frontline: number;
  /** The player's confirmed backing, or `null` if they have not picked. */
  readonly backing: Backing | null;
}

/**
 * The wallet fragment §42.2 keeps at the global view.
 *
 * `null` until a wallet is connected, which renders as an explicit
 * disconnected state. §42.14 asks for useful sync states rather than a
 * placeholder that looks like a real balance of zero.
 */
export interface WalletSummary {
  /** Shortened address, e.g. `0x4f2…9c1`. Never the full address in the HUD. */
  readonly addressFragment: string;
  /**
   * `$WAR` balance, already formatted from base units by the caller.
   *
   * A string, not a number. §66.3 keeps token amounts in integer base units all
   * the way to the edge; formatting them into a float here to render them would
   * be the one place the rule quietly breaks.
   */
  readonly warBalance: string;
  /** Current-window War Points (§16.2). A whole count, not a token amount. */
  readonly warPoints: number;
}

/**
 * A pick the player is composing but the server has not confirmed (§42.5).
 *
 * Transient interaction state, which is exactly what §80.2 allows the store to
 * hold. It is deliberately separate from `ClientBattle.backing`: one is what the
 * player is doing, the other is what is true.
 */
export interface PendingPick {
  readonly battleId: string;
  readonly ticker: ActiveTicker;
}

/**
 * The authoritative round, as the client last heard it (§22, §23.5).
 *
 * State and clock arrive together because they are only meaningful together: a
 * countdown without the phase it belongs to is a number, and a phase without the
 * clock cannot say how long it lasts.
 */
export interface ClientRound {
  readonly roundId: string;
  readonly state: RoundState;
  readonly clock: CanonicalClock;
  /**
   * Public feed health (§23.6).
   *
   * `HEALTHY` or `DEGRADED` only — the client is told when data is late, but
   * `STALE` and `UNAVAILABLE` are engine-side conditions that void a battle
   * rather than states a player watches.
   */
  readonly feedHealth: PublicFeedHealth;
}

/**
 * How a decision reaches the server (§47.5, §47.6).
 *
 * `null` when there is nobody to tell — a preview build, or a visitor with no
 * session. That is not a degraded mode: §5 makes spectating the normal case,
 * and the controls simply offer nothing a spectator cannot do.
 *
 * Each call returns the failure rather than throwing, because §110.5 wants the
 * reason shown. A rejected pick and a dropped connection are different things
 * to tell a player who is watching a lock approach.
 */
export interface PickGateway {
  back: (battleId: string, ticker: ActiveTicker) => Promise<PickAttempt>;
  withdraw: () => Promise<PickAttempt>;
  decide: (decision: CardDecision) => Promise<PickAttempt>;
}

/** What came back from a write: nothing, or a sentence to show. */
export type PickAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly nextStep: string };

interface SessionState {
  readonly camera: CameraState;
  readonly cameraConfig: CameraConfig;
  /** Drag and drift for direct navigation (§37.3, §37.4). */
  readonly navigation: NavigationState;
  readonly navigationConfig: NavigationConfig;
  /**
   * Whether the gesture in progress has travelled far enough to be a drag.
   *
   * §37.3 and §37.4 give tap and drag to the same button and the same finger, so
   * something has to tell them apart. Without this, panning the world across a
   * sector releases into a click and flies the camera somewhere the player never
   * asked to go.
   */
  readonly dragMoved: boolean;
  readonly battles: readonly ClientBattle[];
  /** The player's own battle this round, if they picked (§37.7 FOCUS MY WAR). */
  readonly myBattleId: string | null;
  readonly quality: QualityTier;
  readonly reducedMotion: boolean;
  readonly wallet: WalletSummary | null;
  readonly pendingPick: PendingPick | null;
  /** `null` before the first round payload arrives (§42.14 sync state). */
  readonly round: ClientRound | null;
  /**
   * When the reshuffle between two rounds began, or `null` (§15).
   *
   * Set when the round *changes*, never when the same round is re-fetched — a
   * resync after a dropped socket would otherwise tear the world down and
   * rebuild it for a round already in progress. The first round a client ever
   * sees sets nothing either: there is no previous world to take apart.
   */
  readonly reshuffleStartedAt: UtcTimestamp | null;
  /** The wallet's Genesis Card, or `null` when it holds none (§7). */
  readonly card: CardHolding | null;
  /**
   * USE or SAVE for this round, before the server confirms it (§40.7).
   *
   * Local like `pendingPick`, and for the same reason: arming a card is a
   * decision the player has made, not yet a fact about the round. The use is
   * consumed at lock, so nothing here spends anything.
   */
  readonly cardDecision: CardDecision | null;
  readonly connection: ConnectionState;
  /** The server side of the pick flow, or `null` for a spectator. */
  readonly picks: PickGateway | null;
  /** The most recent refusal, or `null`. Cleared by the next attempt. */
  readonly pickError: { readonly message: string; readonly nextStep: string } | null;
  /**
   * The last round's results, keyed by battle (§27.8).
   *
   * Kept because §12.6 reveals the breakdown at finalization and the result
   * screen is reached after the round it describes has ended — a client that
   * dropped them on the next `ROUND_OPENED` would have nothing to show the
   * player who just watched a battle finish.
   */
  readonly lastResults: Readonly<Record<string, FinalizedBattleResult>>;
  /**
   * Server time minus local time, in milliseconds (§23.5).
   *
   * Every countdown is projected through this. The device clock is never
   * authority — a player whose laptop is four minutes fast must still see the
   * same lock time as everyone else.
   */
  readonly clockOffsetMs: number;

  setBattles: (battles: readonly ClientBattle[]) => void;
  setMyBattle: (battleId: string | null) => void;
  setQuality: (tier: QualityTier) => void;
  setReducedMotion: (reduced: boolean) => void;
  setWallet: (wallet: WalletSummary | null) => void;
  /**
   * Applies the authoritative round, and starts a reshuffle if it is a new one.
   *
   * The timestamp is passed in rather than read here, for the same reason every
   * other reducer in this store takes one: §23.5 keeps the client clock out of
   * anything that decides, and a test needs to place the sequence exactly.
   */
  setRound: (round: ClientRound | null, at: UtcTimestamp) => void;
  setCard: (card: CardHolding | null) => void;
  decideCard: (decision: CardDecision | null) => void;
  setConnection: (connection: ConnectionState) => void;
  setPickGateway: (gateway: PickGateway | null) => void;
  setPickError: (error: { readonly message: string; readonly nextStep: string } | null) => void;
  /** Replaces the kept results, as a finalization does for a whole round. */
  setLastResults: (results: readonly FinalizedBattleResult[]) => void;
  /**
   * Adds one result without displacing the others.
   *
   * Separate from `setLastResults` because the two mean different things: a
   * finalization supersedes the previous round, while a result fetched by id
   * joins what is already known. Using the replacing one here would drop the
   * other four battles of the round a player is looking at.
   */
  rememberResult: (result: FinalizedBattleResult) => void;
  /**
   * Applies the server's answer about this wallet's own pick (§47.5).
   *
   * Patches `backing` on the one battle rather than replacing the list, so a
   * pick the player is composing right now survives the round of trips it takes
   * to confirm the last one.
   */
  applyMyBacking: (battleId: string | null, backing: Backing | null) => void;
  setClockOffset: (offsetMs: number) => void;
  /** Composes a pick for the focused battle (§42.5 step 3). */
  proposePick: (pick: PendingPick | null) => void;

  tick: (at: UtcTimestamp) => void;
  focusSector: (index: number, at: UtcTimestamp) => void;
  enterBattlefield: (index: number, at: UtcTimestamp) => void;
  playCinematic: (index: number, at: UtcTimestamp) => void;
  focusMyWar: (at: UtcTimestamp) => void;
  resetView: (at: UtcTimestamp) => void;
  /** Frames the world for a page presented over it, and back again (§81.2). */
  presentWorld: (presenting: boolean, at: UtcTimestamp) => void;

  /** Drag (§37.3 left drag, §37.4 one-finger drag). */
  startDrag: (sample: PointerSample) => void;
  /** Marks the gesture as a drag, so its release is not read as a tap. */
  noteDragMoved: () => void;
  dragTo: (sample: PointerSample, perPixel: number) => void;
  finishDrag: (at: UtcTimestamp) => void;
  /** Wheel (§37.3) and pinch (§37.4) both reach the same zoom. */
  zoomNotches: (notches: number) => void;
  pinch: (ratio: number) => void;
  /** `ESC`: one spatial level outward (§37.3). */
  stepOutward: (at: UtcTimestamp) => void;
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

/**
 * The sector index of the focused battle, or `null` when none is focused.
 *
 * Derived rather than stored. A second copy of "which battle is selected" is a
 * second thing that can be wrong, and the camera already owns the answer.
 */
function focusedSectorIndex(state: Pick<SessionState, 'battles' | 'camera'>): number | null {
  const { focusedBattleId } = state.camera;
  if (focusedBattleId === null) {
    return null;
  }
  const index = state.battles.findIndex((battle) => battle.battleId === focusedBattleId);
  return index < 0 ? null : index;
}

export const useSession = create<SessionState>((set, get) => ({
  camera: initialCamera(configFor(false)),
  cameraConfig: configFor(false),
  navigation: IDLE_NAVIGATION,
  navigationConfig: NAVIGATION,
  dragMoved: false,
  battles: [],
  myBattleId: null,
  quality: 'BALANCED',
  reducedMotion: false,
  wallet: null,
  pendingPick: null,
  round: null,
  reshuffleStartedAt: null,
  card: null,
  cardDecision: null,
  connection: 'CONNECTED',
  picks: null,
  pickError: null,
  lastResults: {},
  clockOffsetMs: 0,

  setBattles: (battles) => {
    // A pick aimed at a battle that no longer exists — a reshuffle, a
    // reconnect — is dropped rather than left pointing at nothing.
    const { pendingPick } = get();
    const stillOffered =
      pendingPick !== null && battles.some((battle) => battle.battleId === pendingPick.battleId);
    // The card decision goes with the pick it belonged to. An armed card left
    // pointing at a battle that no longer exists would read as armed for
    // whatever replaced it.
    set({
      battles,
      pendingPick: stillOffered ? pendingPick : null,
      cardDecision: stillOffered ? get().cardDecision : null,
    });
  },

  setMyBattle: (battleId) => {
    set({ myBattleId: battleId });
  },

  setQuality: (quality) => {
    set({ quality });
  },

  setWallet: (wallet) => {
    set({ wallet });
  },

  setRound: (round, at) => {
    const previous = get().round;
    const changed = previous !== null && round !== null && previous.roundId !== round.roundId;
    set({ round, ...(changed ? { reshuffleStartedAt: at } : {}) });
  },

  setCard: (card) => {
    set({ card });
  },

  decideCard: (cardDecision) => {
    set({ cardDecision });
  },

  setConnection: (connection) => {
    set({ connection });
  },

  setPickGateway: (picks) => {
    set({ picks });
  },

  setPickError: (pickError) => {
    set({ pickError });
  },

  setLastResults: (results) => {
    set({
      lastResults: Object.fromEntries(results.map((result) => [result.battleId, result])),
    });
  },

  rememberResult: (result) => {
    set({ lastResults: { ...get().lastResults, [result.battleId]: result } });
  },

  applyMyBacking: (battleId, backing) => {
    set({
      battles: get().battles.map((battle) =>
        battle.battleId === battleId ? { ...battle, backing } : { ...battle, backing: null },
      ),
      myBattleId: backing === null ? null : battleId,
    });
  },

  setClockOffset: (clockOffsetMs) => {
    set({ clockOffsetMs });
  },

  proposePick: (pendingPick) => {
    set({ pendingPick });
  },

  setReducedMotion: (reducedMotion) => {
    // Rebuilding the config rather than patching it keeps the camera and the
    // stylesheet reading the same durations (§15, §83.3).
    set({ reducedMotion, cameraConfig: configFor(reducedMotion) });
  },

  tick: (at) => {
    const { camera, cameraConfig, navigation, navigationConfig } = get();
    // A queued fly-to first, then any residual drift. `applyDrift` stands down
    // while a transition is running, so the two never fight over the pose.
    const advanced = advance(camera, at, cameraConfig);
    const drifted = applyDrift(advanced, navigation, at, cameraConfig, navigationConfig);
    // Reference equality when nothing moved, so a still camera does not
    // re-render the tree sixty times a second.
    if (drifted.camera !== camera || drifted.navigation !== navigation) {
      set({ camera: drifted.camera, navigation: drifted.navigation });
    }
  },

  startDrag: (sample) => {
    const { camera, navigation } = get();
    set({ ...beginPan(camera, navigation, sample), dragMoved: false });
  },

  noteDragMoved: () => {
    if (!get().dragMoved) {
      set({ dragMoved: true });
    }
  },

  dragTo: (sample, perPixel) => {
    const { camera, navigation, cameraConfig } = get();
    set(panTo(camera, navigation, sample, perPixel, cameraConfig));
  },

  finishDrag: (at) => {
    const { navigation, cameraConfig } = get();
    set({ navigation: endPan(navigation, at, cameraConfig) });
  },

  zoomNotches: (notches) => {
    const { camera, cameraConfig, navigationConfig } = get();
    set({ camera: zoomByNotches(camera, notches, cameraConfig, navigationConfig) });
  },

  pinch: (ratio) => {
    const { camera, cameraConfig, navigationConfig } = get();
    set({ camera: pinchTo(camera, ratio, cameraConfig, navigationConfig) });
  },

  stepOutward: (at) => {
    const state = get();
    const sectorIndex = focusedSectorIndex(state);
    const poseFor = (mode: CameraMode): ReturnType<typeof poseForMode> =>
      poseForMode(mode, sectorIndex);
    set({
      camera: stepOutward(state.camera, poseFor, at, state.cameraConfig),
      // Stepping out is a deliberate move to a known place. Letting a leftover
      // flick keep sliding the camera afterwards would undo it.
      navigation: IDLE_NAVIGATION,
    });
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

  presentWorld: (presenting, at) => {
    const { camera, cameraConfig } = get();

    // Only from and to the free global view. A visitor who followed a shared
    // link into a sector and then opened the about page should come back to
    // the sector they were watching, not be reset to the anchor — §37.9 keeps
    // the world persistent, and the camera is part of what persists.
    if (presenting) {
      if (camera.mode !== 'GLOBAL_FREE') {
        return;
      }
      set({
        camera: flyTo(
          camera,
          {
            to: PRESENTATION_ANCHOR,
            mode: 'PROFILE_PRESENTATION',
            at,
            duration: cameraConfig.durations.spatialTransition,
            battleId: null,
          },
          cameraConfig,
        ),
      });
      return;
    }

    if (camera.mode !== 'PROFILE_PRESENTATION') {
      return;
    }
    set({ camera: resetView(camera, at, cameraConfig) });
  },
}));

/**
 * A development-only handle on the store.
 *
 * Camera behaviour is the one part of this app that cannot be read off the DOM:
 * a wrong sign or a wrong scale looks like a plausible picture, and the only way
 * to tell is to read the pose. `import.meta.env.DEV` is a compile-time constant,
 * so this whole block is dropped from the production bundle.
 */
if (import.meta.env.DEV) {
  (globalThis as unknown as { __ponswarsSession?: typeof useSession }).__ponswarsSession =
    useSession;
}

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

/**
 * The current instant on the *server's* clock (§23.5).
 *
 * Local time shifted by the observed offset. Every countdown reads from here
 * rather than from `Date.now()` directly, so a skewed device clock changes
 * nothing about when a round locks.
 */
export function serverNowMs(state: Pick<SessionState, 'clockOffsetMs'>): number {
  return Date.now() + state.clockOffsetMs;
}

/** The current spatial level (§37.2). */
export function currentZoom(state: Pick<SessionState, 'camera'>): ZoomLevel {
  return zoomLevelForMode(state.camera.mode);
}

/** What the HUD may show right now (§37.6). */
export function currentHudBudget(state: Pick<SessionState, 'camera'>): HudBudget {
  return hudBudgetFor(currentZoom(state));
}
