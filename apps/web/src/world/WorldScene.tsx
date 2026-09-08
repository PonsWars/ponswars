import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import { selectDetail, type DetailLevel, type LodThresholds } from '@ponswars/world-runtime';
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef, type JSX } from 'react';
import type { Group, PerspectiveCamera } from 'three';
import { currentZoom, nowUtc, useSession, type ClientBattle } from '../state/session.js';
import { MARKET_CORE, SECTOR_POSITIONS } from './layout.js';
import { WorldInput } from './WorldInput.js';

/**
 * The persistent world scene (§37.9, §38).
 *
 * §37.9 is the rule this file is built around: *"The world scene should remain
 * persistent across battle focus changes ... Do not destroy/recreate the full
 * world on every navigation action."* Nothing here unmounts when the player
 * moves between levels — what changes is the camera, the level of detail and
 * the HUD.
 *
 * The geometry is placeholder. §33 of the visual guide is explicit that the
 * delivered PNGs are art direction and *"production UI must be recreated as
 * semantic, responsive components"* with real assets; standing in a primitive
 * now is how the spatial behaviour gets proven before any of that exists.
 */

/**
 * LOD distances.
 *
 * `OPEN` production tuning (§59.4). Sized to the layout in `layout.ts` so the
 * ring degrades visibly as the camera pulls back, which is the behaviour worth
 * seeing in a prototype.
 */
const LOD_THRESHOLDS: LodThresholds = { full: 320, reduced: 700, silhouette: 2_200 };

/** How many segments a sector platform gets at each detail level (§82.2). */
const SEGMENTS: Readonly<Record<DetailLevel, number>> = {
  FULL: 48,
  REDUCED: 20,
  SILHOUETTE: 8,
  CULLED: 3,
};

function MarketCore(): JSX.Element {
  const core = useRef<Group>(null);

  // §38.10: a permanent dark cinematic atmosphere whose lighting shifts by
  // phase, and §36.14 keeps the world subtly alive through slow rotation rather
  // than particles. A steady drift, not a spin.
  useFrame((_, delta) => {
    if (core.current !== null) {
      core.current.rotation.y += delta * 0.06;
    }
  });

  return (
    <group ref={core} position={[MARKET_CORE.x, MARKET_CORE.y, MARKET_CORE.z]}>
      <mesh>
        <icosahedronGeometry args={[46, 1]} />
        <meshStandardMaterial
          color="#16222c"
          metalness={0.85}
          roughness={0.35}
          emissive="#0a2028"
          emissiveIntensity={0.6}
        />
      </mesh>
      {/* Routing pulses out into the sectors (§38.2). */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[70, 74, 64]} />
        <meshBasicMaterial color="#1d3f4d" transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

interface SectorProps {
  readonly index: number;
  readonly battle: ClientBattle | undefined;
  readonly detail: DetailLevel;
  readonly isFocused: boolean;
  readonly onSelect: (index: number) => void;
}

function Sector({ index, battle, detail, isFocused, onSelect }: SectorProps): JSX.Element | null {
  const position = SECTOR_POSITIONS[index];
  if (position === undefined || detail === 'CULLED') {
    return null;
  }

  // Faction accents mark the two staging areas. Design tokens §3: identity cues
  // and local highlights, never a fill across the UI — and §36.7 keeps the
  // faction identifiable without colour anyway.
  const leftAccent = battle === undefined ? '#3a4a55' : FACTION_ACCENT[battle.left];
  const rightAccent = battle === undefined ? '#3a4a55' : FACTION_ACCENT[battle.right];

  return (
    <group position={[position.x, position.y, position.z]}>
      {/* The neutral sector platform. No faction owns it (§38.3). */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(index);
        }}
      >
        <circleGeometry args={[120, SEGMENTS[detail]]} />
        <meshStandardMaterial
          color={isFocused ? '#16242e' : '#0f1a22'}
          metalness={0.6}
          roughness={0.7}
        />
      </mesh>

      {/* Two staging areas with a contested centre between them (§38.3). */}
      <mesh position={[-62, 6, 0]}>
        <boxGeometry args={[46, 12, 96]} />
        <meshStandardMaterial color={leftAccent} metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[62, 6, 0]}>
        <boxGeometry args={[46, 12, 96]} />
        <meshStandardMaterial color={rightAccent} metalness={0.4} roughness={0.5} />
      </mesh>

      {/*
        The frontline marker. Its position is the normalized frontline from the
        realtime stream — §13 makes the battlefield a visualisation of
        authoritative momentum, never a source of it.
      */}
      {detail !== 'SILHOUETTE' && battle !== undefined ? (
        <mesh position={[(battle.frontline - 0.5) * 124, 10, 0]}>
          <boxGeometry args={[3, 20, 100]} />
          <meshBasicMaterial color="#d7e6ee" transparent opacity={0.8} />
        </mesh>
      ) : null}
    </group>
  );
}

export function WorldScene(): JSX.Element {
  const camera = useSession((state) => state.camera);
  const battles = useSession((state) => state.battles);
  const quality = useSession((state) => state.quality);
  const focusSector = useSession((state) => state.focusSector);
  const tick = useSession((state) => state.tick);
  const three = useThree();

  // One clock drives both the camera reducer and the render. The reducer takes
  // an absolute timestamp, so a dropped frame advances further along the same
  // curve rather than leaving the camera short (§114.3).
  useFrame(() => {
    tick(nowUtc());
    const active = three.camera as PerspectiveCamera;
    active.position.set(camera.pose.position.x, camera.pose.position.y, camera.pose.position.z);
    active.lookAt(camera.pose.target.x, camera.pose.target.y, camera.pose.target.z);
  });

  const zoom = currentZoom({ camera });

  const details = useMemo(
    () =>
      SECTOR_POSITIONS.map((sectorPosition, index) =>
        selectDetail({
          camera: camera.pose,
          sectorPosition,
          isFocused: battles[index]?.battleId === camera.focusedBattleId,
          thresholds: LOD_THRESHOLDS,
          tier: quality,
        }),
      ),
    [camera.pose, camera.focusedBattleId, battles, quality],
  );

  return (
    <>
      {/* §36.5: a dark neutral scene with restrained emissive accents. Faction
          colour is an accent, never a full-screen wash. */}
      <color attach="background" args={['#05080b']} />
      <fog attach="fog" args={['#05080b', 900, 3_000]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[400, 900, 300]} intensity={1.1} />

      <WorldInput />

      <MarketCore />

      {SECTOR_POSITIONS.map((_, index) => (
        <Sector
          key={index}
          index={index}
          battle={battles[index]}
          detail={details[index] ?? 'SILHOUETTE'}
          isFocused={battles[index]?.battleId === camera.focusedBattleId}
          onSelect={(selected) => {
            // A pan that happens to end over a sector is not a click on it.
            // Without this, dragging across the world flies the camera to
            // whatever the finger was over when it lifted.
            if (useSession.getState().dragMoved) {
              return;
            }
            // Tapping a sector node flies to it (§37.3, §37.4). At the sector
            // level a second tap descends to the battlefield.
            const now = nowUtc();
            if (zoom >= 2 && battles[selected]?.battleId === camera.focusedBattleId) {
              useSession.getState().enterBattlefield(selected, now);
            } else {
              focusSector(selected, now);
            }
          }}
        />
      ))}
    </>
  );
}
