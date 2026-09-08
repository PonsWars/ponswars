import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { worldUnitsPerPixel } from '@ponswars/world-runtime';
import { nowUtc, useSession } from '../state/session.js';

/**
 * Turns real input into camera reducer calls (§37.3 desktop, §37.4 mobile).
 *
 * This is the only file in the app that knows what a pointer event is. All the
 * behaviour lives in `@ponswars/world-runtime` as pure reducers — this listens,
 * measures and forwards. Keeping the boundary that sharp is what lets the camera
 * be tested without a browser.
 *
 * Native listeners rather than React handlers, because the wheel one has to be
 * registered as non-passive: zooming must call `preventDefault` or the page
 * scrolls underneath the world. React attaches wheel listeners passively, where
 * `preventDefault` is ignored and warns. Touch needs no such listener — the
 * stylesheet gives the canvas `touch-action: none`, which hands drag and pinch
 * to the world without suppressing the tap that selects a sector.
 *
 * Renders nothing. It exists inside the canvas because that is where the
 * viewport height and field of view are, and a pan needs both to convert pixels
 * into world units.
 */
/**
 * How far a pointer may travel and still count as a tap.
 *
 * Six pixels is under the slop a finger introduces on a deliberate tap and well
 * under any intentional pan.
 */
const TAP_SLOP_PX = 6;

export function WorldInput(): null {
  const startDrag = useSession((state) => state.startDrag);
  const dragTo = useSession((state) => state.dragTo);
  const finishDrag = useSession((state) => state.finishDrag);
  const zoomNotches = useSession((state) => state.zoomNotches);
  const pinch = useSession((state) => state.pinch);
  const stepOutward = useSession((state) => state.stepOutward);
  const noteDragMoved = useSession((state) => state.noteDragMoved);

  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    const element = gl.domElement;

    /** How many world units one pixel covers, at the current view distance. */
    const perPixel = (): number => {
      const { camera: cameraState } = useSession.getState();
      const view = cameraState.pose;
      const distance = Math.hypot(
        view.position.x - view.target.x,
        view.position.y - view.target.y,
        view.position.z - view.target.z,
      );
      // A perspective camera in Three.js measures its vertical field of view in
      // degrees; the reducer works in radians.
      const fov = 'fov' in camera ? (camera.fov * Math.PI) / 180 : Math.PI / 4;
      return worldUnitsPerPixel(distance, fov, size.height);
    };

    /**
     * Live touches, so a second finger turns the drag into a pinch.
     *
     * §37.4 keeps gesture complexity low: one finger pans, two fingers zoom, and
     * there is no third gesture to disambiguate.
     */
    const touches = new Map<number, { x: number; y: number }>();
    let pinchStartSeparation: number | null = null;
    /** Where the current one-finger gesture began, for the tap/drag decision. */
    let gestureOrigin: { x: number; y: number } | null = null;

    const separation = (): number | null => {
      const [first, second] = [...touches.values()];
      if (first === undefined || second === undefined) {
        return null;
      }
      return Math.hypot(first.x - second.x, first.y - second.y);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        // Left drag pans (§37.3). Right drag is reserved for the optional orbit
        // and must not be silently treated as a pan in the meantime.
        return;
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (touches.size === 2) {
        // A second finger ends the pan and begins a pinch, so the camera does
        // not pan and zoom from the same gesture at once.
        finishDrag(nowUtc());
        pinchStartSeparation = separation();
        return;
      }
      if (touches.size > 2) {
        return;
      }

      element.setPointerCapture(event.pointerId);
      gestureOrigin = { x: event.clientX, y: event.clientY };
      startDrag({ x: event.clientX, y: event.clientY, at: nowUtc() });
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!touches.has(event.pointerId)) {
        return;
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (touches.size >= 2) {
        const current = separation();
        if (current !== null && pinchStartSeparation !== null && pinchStartSeparation > 0) {
          pinch(current / pinchStartSeparation);
          // Re-baselining each frame makes the ratio incremental, so the zoom
          // tracks the fingers instead of snapping back to the gesture's start.
          pinchStartSeparation = current;
        }
        return;
      }

      if (
        gestureOrigin !== null &&
        Math.hypot(event.clientX - gestureOrigin.x, event.clientY - gestureOrigin.y) > TAP_SLOP_PX
      ) {
        noteDragMoved();
      }
      dragTo({ x: event.clientX, y: event.clientY, at: nowUtc() }, perPixel());
    };

    const endPointer = (event: PointerEvent): void => {
      if (!touches.delete(event.pointerId)) {
        return;
      }
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (touches.size < 2) {
        pinchStartSeparation = null;
      }
      // Lifting one of two fingers leaves a stale drag origin, so the remaining
      // finger starts a fresh pan rather than jumping the camera by the gap
      // between the two.
      if (touches.size === 1) {
        const [remaining] = [...touches.values()];
        if (remaining !== undefined) {
          gestureOrigin = { x: remaining.x, y: remaining.y };
          startDrag({ x: remaining.x, y: remaining.y, at: nowUtc() });
          // A pinch is never a tap, whatever the remaining finger does next.
          noteDragMoved();
          return;
        }
      }
      gestureOrigin = null;
      finishDrag(nowUtc());
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      // Browsers report wheel deltas in pixels, lines or pages depending on the
      // device. Normalising to a notch by sign keeps a trackpad and a mouse
      // wheel moving the camera by the same amount per gesture.
      zoomNotches(Math.sign(event.deltaY));
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        stepOutward(nowUtc());
      }
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', endPointer);
    element.addEventListener('pointercancel', endPointer);
    element.addEventListener('wheel', onWheel, { passive: false });
    // ESC is a global orientation rail (§37.7), so it works wherever focus is.
    window.addEventListener('keydown', onKeyDown);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', endPointer);
      element.removeEventListener('pointercancel', endPointer);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    gl,
    camera,
    size.height,
    startDrag,
    dragTo,
    finishDrag,
    zoomNotches,
    pinch,
    stepOutward,
    noteDragMoved,
  ]);

  return null;
}
