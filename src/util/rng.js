/**
 * Seedable RNG. Every random draw in the visualizer goes through one of these so a track
 * renders identically on every run — which is what makes the offline exporter able to
 * resume a render from frame N after a GPU context loss.
 */

/** mulberry32: 32-bit state, no dependencies, good enough for visual scatter. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, for deriving a seed from a track's name. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The sim and the mapping layer draw from separate streams. If they shared one, adding a
 * single random call on the sim side would shift every subsequent mapping decision and
 * silently change how an already-tuned preset looks.
 */
export function makeStreams(seed) {
  return {
    seed,
    rngSim: mulberry32(seed),
    rngMap: mulberry32((seed ^ 0x9e3779b9) >>> 0)
  };
}
