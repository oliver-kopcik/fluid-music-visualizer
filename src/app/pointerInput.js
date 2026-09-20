/**
 * Mouse and touch wiring, lifted out of the sim. Upstream bound these listeners at module
 * scope, which meant a render could never be isolated from stray input; here the export
 * path simply never calls attachPointerInput.
 */
import { scaleByPixelRatio } from './loop.js';

const MOUSE_ID = -1;

export function attachPointerInput(sim) {
  const canvas = sim.canvas;

  const onMouseDown = (e) => {
    sim.pointerDown(MOUSE_ID, scaleByPixelRatio(e.offsetX), scaleByPixelRatio(e.offsetY));
  };

  const onMouseMove = (e) => {
    sim.pointerMove(MOUSE_ID, scaleByPixelRatio(e.offsetX), scaleByPixelRatio(e.offsetY));
  };

  const onMouseUp = () => sim.pointerUp(MOUSE_ID);

  const onTouchStart = (e) => {
    e.preventDefault();
    for (const touch of e.targetTouches) {
      sim.pointerDown(touch.identifier, scaleByPixelRatio(touch.pageX), scaleByPixelRatio(touch.pageY));
    }
  };

  const onTouchMove = (e) => {
    e.preventDefault();
    for (const touch of e.targetTouches) {
      sim.pointerMove(touch.identifier, scaleByPixelRatio(touch.pageX), scaleByPixelRatio(touch.pageY));
    }
  };

  const onTouchEnd = (e) => {
    for (const touch of e.changedTouches) sim.pointerUp(touch.identifier);
  };

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd);

  return function detachPointerInput() {
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
  };
}
