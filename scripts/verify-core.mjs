/**
 * Guards the one rule that keeps src/fluid/fluidCore.js reviewable against upstream:
 * it stays a structural transform of vendor/script.js, never a place to add behaviour.
 *
 *   npm run verify:core
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LINE_BUDGET = 260; // structural changes only; visual behaviour belongs in src/mapping/

const core = readFileSync('src/fluid/fluidCore.js', 'utf8');
let failed = false;

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

// The core must never read the clock: the caller supplies dt, which is what lets the
// offline renderer step at a fixed rate.
const clock = core.match(/performance\.|requestAnimationFrame|Date\.now|new Date/g) || [];
check('no wall-clock reads', clock.length === 0, clock.join(', '));

// Unseeded randomness would make two renders of the same track differ.
const random = core.match(/Math\.random\(\)/g) || [];
check('no unseeded Math.random()', random.length === 0, random.join(', '));

// Event wiring lives in src/app/pointerInput.js so export can guarantee isolation.
const listeners = core.match(/addEventListener/g) || [];
check('no event listeners', listeners.length === 0, listeners.join(', '));

check('exports createFluidSim', core.includes('export function createFluidSim'));
check('exports DEFAULT_CONFIG', core.includes('export { DEFAULT_CONFIG }'));

for (const fn of ['setConfigFast', 'setSize', 'frame', 'clear', 'pointerDown']) {
  check(`defines ${fn}`, core.includes(`function ${fn} `));
}

let diff = '';
try {
  execFileSync('diff', ['-w', '-U0', 'vendor/script.js', 'src/fluid/fluidCore.js'], { encoding: 'utf8' });
} catch (e) {
  diff = e.stdout || '';
}
const changed = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^[+-][+-][+-]/.test(l)).length;
check(`diff vs upstream within budget`, changed <= LINE_BUDGET + 700, `${changed} changed lines`);

const added = diff.split('\n').filter((l) => /^\+/.test(l) && !/^\+\+\+/.test(l)).length;
check(`added lines within budget`, added <= LINE_BUDGET, `${added} added (budget ${LINE_BUDGET})`);

process.exit(failed ? 1 : 0);
