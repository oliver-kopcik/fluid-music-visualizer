/**
 * dt-correct smoothing.
 *
 * The naive `s += (x - s) * 0.1` is everywhere in visualizer code and it is wrong as soon
 * as the frame rate varies: the same coefficient smooths twice as hard at 120fps as at
 * 60. Since the whole point here is that a 60fps export matches a possibly-30fps preview,
 * every filter uses the exponential form with an explicit time constant.
 */

export class OnePole {
  constructor(tau, initial = 0) {
    this.tau = tau;
    this.value = initial;
  }
  step(target, dt) {
    if (this.tau <= 0) {
      this.value = target;
      return target;
    }
    this.value += (target - this.value) * (1 - Math.exp(-dt / this.tau));
    return this.value;
  }
  reset(v = 0) {
    this.value = v;
  }
}

/** Fast to rise, slow to fall — for anything that should feel like a transient. */
export class Envelope {
  constructor(attack, release, initial = 0) {
    this.attack = attack;
    this.release = release;
    this.value = initial;
  }
  step(target, dt) {
    const tau = target > this.value ? this.attack : this.release;
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
  reset(v = 0) {
    this.value = v;
  }
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
