/**
 * One-shot tool: derive src/fluid/fluidCore.js from vendor/script.js.
 *
 * Upstream is a flat script that grabs the canvas from the DOM, builds a dat.gui, wires
 * its own event listeners and starts its own requestAnimationFrame loop. We need the same
 * simulation as a library: caller-supplied canvas, injected RNG, explicit sizing, and a
 * step/render split so an offline renderer can drive it at a fixed dt.
 *
 * Every edit is a line-range op against upstream, listed below, so the transform stays
 * auditable. `npm run verify:core` diffs the result against vendor ignoring whitespace.
 *
 *   node scripts/build-core.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync('vendor/script.js', 'utf8').split(/\r?\n/);
const at = (a, b) => lines.slice(a - 1, b).join('\n'); // 1-indexed, inclusive

const callSites = readFileSync('scripts/.shader-callsites.txt', 'utf8').trimEnd();
const shaderImports = readFileSync('scripts/.shader-imports.txt', 'utf8').trimEnd();

const MIT_HEADER = at(1, 23);
const CONFIG_BODY = at(60, 84); // key/value lines only, without `let config = {` and `}`

/** Applied in order. Any line not covered by an op is kept verbatim. */
const ops = [
  { from: 24, to: 25, note: "'use strict' — ES modules are always strict", replace: null },
  { from: 26, to: 54, note: 'mobile promo popup + app store links', replace: null },
  {
    from: 55,
    to: 57,
    note: "canvas is a parameter now; sizing is the caller's job (see setSize)",
    replace: ['// Simulation section']
  },
  {
    from: 58,
    to: 85,
    note: 'config literal hoisted to module scope as DEFAULT_CONFIG',
    replace: [
      '',
      '// BACK_COLOR is cloned so two sims never share one object.',
      'const config = Object.assign({}, DEFAULT_CONFIG, {',
      '    BACK_COLOR: Object.assign({}, DEFAULT_CONFIG.BACK_COLOR)',
      '}, options.config);'
    ]
  },
  { from: 115, to: 116, note: 'startGUI() call — the GUI lives in src/ui/gui.js', replace: null },
  {
    from: 155,
    to: 156,
    note: "upstream's Google Analytics ping — no `ga` global here, and we don't phone home",
    replace: null
  },
  { from: 208, to: 282, note: 'startGUI() body — replaced by lil-gui in src/ui/gui.js', replace: null },
  { from: 287, to: 300, note: 'captureScreenshot — download half moved to src/export/screenshot.js', replace: null },
  { from: 342, to: 350, note: 'downloadURI — moved to src/export/screenshot.js', replace: null },
  {
    from: 440,
    to: 913,
    note: 'GLSL moved to shaders.js by scripts/extract-shaders.mjs',
    replace: [
      '// Shader sources live in ./shaders.js. Compilation stays here because it needs `gl`.',
      callSites
    ]
  },
  {
    from: 960,
    to: 960,
    note: 'dithering texture URL comes from the bundler so it gets fingerprinted',
    replace: ['let ditheringTexture = createTextureAsync(ditheringTextureUrl);']
  },
  {
    from: 1147,
    to: 1157,
    note: 'expose a load promise: an offline render must not start on the 1x1 placeholder',
    replace: [
      '    let resolveReady;',
      '    obj.ready = new Promise(resolve => { resolveReady = resolve; });',
      '',
      '    let image = new Image();',
      '    image.onload = () => {',
      '        obj.width = image.width;',
      '        obj.height = image.height;',
      '        gl.bindTexture(gl.TEXTURE_2D, texture);',
      '        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);',
      '        resolveReady(obj);',
      '    };',
      '    // Resolve on error too — a missing dithering texture degrades sunrays, it must not hang.',
      '    image.onerror = () => resolveReady(obj);',
      '    image.src = url;',
      '',
      '    return obj;'
    ]
  },
  {
    from: 1170,
    to: 1170,
    note: 'random opening splats would make renders non-reproducible',
    replace: ['if (options.initialSplats)', '    multipleSplats(options.initialSplats);']
  },
  {
    from: 1172,
    to: 1174,
    note: 'wall-clock bootstrap + self-starting rAF loop move to src/app/loop.js',
    replace: ['let colorUpdateTimer = 0.0;']
  },
  {
    from: 1176,
    to: 1194,
    note: 'update()/calcDeltaTime() read the wall clock — the caller supplies dt instead',
    replace: [
      'function frame (dt) {',
      '    updateColors(dt);',
      '    applyInputs();',
      '    if (!config.PAUSED)',
      '        step(dt);',
      '    render(null);',
      '}'
    ]
  },
  {
    from: 1196,
    to: 1205,
    note: 'resizeCanvas() derived its size from CSS layout; export needs an exact backing store',
    replace: [
      'function setSize (width, height) {',
      '    if (canvas.width === width && canvas.height === height)',
      '        return false;',
      '    canvas.width = width;',
      '    canvas.height = height;',
      '    initFramebuffers();',
      '    return true;',
      '}'
    ]
  },
  {
    from: 1464,
    to: 1524,
    note: 'DOM listeners move to src/app/pointerInput.js; export never attaches them',
    replace: [
      '// Pointer entry points. Upstream bound these straight to DOM events; as plain calls',
      '// they let the export path guarantee no stray input contaminates a render.',
      'function pointerDown (id, posX, posY) {',
      '    let pointer = pointers.find(p => p.id == id);',
      '    if (pointer == null) {',
      '        pointer = new pointerPrototype();',
      '        pointers.push(pointer);',
      '    }',
      '    updatePointerDownData(pointer, id, posX, posY);',
      '}',
      '',
      'function pointerMove (id, posX, posY) {',
      '    let pointer = pointers.find(p => p.id == id);',
      '    if (pointer == null || !pointer.down) return;',
      '    updatePointerMoveData(pointer, posX, posY);',
      '}',
      '',
      'function pointerUp (id) {',
      '    let pointer = pointers.find(p => p.id == id);',
      '    if (pointer == null) return;',
      '    updatePointerUpData(pointer);',
      '}',
      '',
      'function pushRandomSplats (amount) {',
      '    splatStack.push(amount);',
      '}'
    ]
  },
  { from: 1633, to: 1637, note: 'scaleByPixelRatio is DPR/layout logic — moved to src/app/loop.js', replace: null }
];

// ---- assemble -------------------------------------------------------------------------
const chunks = [];
let cursor = 24; // everything before this is the MIT header, re-emitted separately
for (const op of ops) {
  if (op.from < cursor) throw new Error('ops out of order at ' + op.from + ' (cursor ' + cursor + ')');
  if (op.from > cursor) chunks.push(at(cursor, op.from - 1));
  if (op.replace) chunks.push(op.replace.join('\n'));
  cursor = op.to + 1;
}
chunks.push(at(cursor, lines.length));

let body = chunks.join('\n');

// Injected RNG: determinism depends on every random draw being seedable.
const randomCount = (body.match(/Math\.random\(\)/g) || []).length;
body = body.replace(/Math\.random\(\)/g, 'rng()');

// The body now lives inside the factory, so indent it one level.
const NL = String.fromCharCode(10);
body = body
  .split(NL)
  .map((l) => (l.trim() === '' ? '' : '    ' + l))
  .join(NL);

const API = [
  '',
  '    const ready = Promise.all([ditheringTexture.ready]);',
  '',
  "    const FRAMEBUFFER_KEYS = new Set([",
  "        'SIM_RESOLUTION', 'DYE_RESOLUTION', 'BLOOM_RESOLUTION', 'SUNRAYS_RESOLUTION'",
  '    ]);',
  "    const KEYWORD_KEYS = new Set(['SHADING', 'BLOOM', 'SUNRAYS']);",
  '',
  '    // Writing a framebuffer key reallocates every texture and wipes the dye, so the two',
  '    // setters are kept apart: setConfig absorbs that cost, setConfigFast refuses to pay it.',
  '    function setConfig (patch) {',
  '        let resize = false;',
  '        let keywords = false;',
  '        for (const key in patch) {',
  '            if (config[key] === patch[key]) continue;',
  '            config[key] = patch[key];',
  '            if (FRAMEBUFFER_KEYS.has(key)) resize = true;',
  '            if (KEYWORD_KEYS.has(key)) keywords = true;',
  '        }',
  '        if (keywords) updateKeywords();',
  '        if (resize) initFramebuffers();',
  '    }',
  '',
  '    function setConfigFast (patch) {',
  '        for (const key in patch) {',
  '            if (FRAMEBUFFER_KEYS.has(key) || KEYWORD_KEYS.has(key))',
  "                throw new Error('setConfigFast: ' + key + ' reallocates framebuffers; use setConfig');",
  '            config[key] = patch[key];',
  '        }',
  '    }',
  '',
  '    function readTarget (target) {',
  '        let texture = framebufferToTexture(target);',
  '        texture = normalizeTexture(texture, target.width, target.height);',
  '        return { data: texture, width: target.width, height: target.height };',
  '    }',
  '',
  '    function captureTarget () {',
  '        let res = getResolution(config.CAPTURE_RESOLUTION);',
  '        let target = createFBO(res.width, res.height, ext.formatRGBA.internalFormat,',
  '                               ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);',
  '        render(target);',
  '        const out = readTarget(target);',
  '        return textureToCanvas(out.data, out.width, out.height);',
  '    }',
  '',
  '    // Reallocating the framebuffers is how upstream zeroes dye and velocity.',
  '    function clear () {',
  '        initFramebuffers();',
  '    }',
  '',
  '    function dispose () {',
  "        const lose = gl.getExtension('WEBGL_lose_context');",
  '        if (lose) lose.loseContext();',
  '    }',
  '',
  '    return {',
  '        canvas, gl, ext, config, ready,',
  '        setConfig, setConfigFast, setSize,',
  '        initFramebuffers, updateKeywords,',
  '        frame, step, render, updateColors, applyInputs,',
  '        splat, splatPointer, multipleSplats, pushRandomSplats,',
  '        pointers, pointerDown, pointerMove, pointerUp,',
  '        correctRadius, generateColor, HSVtoRGB,',
  '        readTarget, captureTarget, clear, dispose',
  '    };',
  '}',
  ''
].join(NL);

const preamble = [
  MIT_HEADER,
  '',
  '/*',
  ' * Derived from vendor/script.js by scripts/build-core.mjs.',
  ' *',
  " * The simulation math and GLSL are Pavel Dobryakov's, unchanged. This file differs from",
  ' * upstream only structurally: it takes the canvas as an argument, takes its RNG and dt',
  ' * from the caller, exposes sizing explicitly, and owns no DOM events, GUI or rAF loop.',
  ' * Run `npm run verify:core` to see that diff.',
  ' *',
  ' * Do not add visual behaviour here. Audio-driven behaviour belongs in src/mapping/.',
  ' */',
  '',
  'import {',
  '  ' + shaderImports,
  "} from './shaders.js';",
  "import ditheringTextureUrl from './LDR_LLL1_0.png?url';",
  '',
  'const DEFAULT_CONFIG = {',
  CONFIG_BODY,
  '};',
  '',
  'export { DEFAULT_CONFIG };',
  '',
  'export function createFluidSim (canvas, options = {}) {',
  '    // Seedable so a track always renders the same way. See src/util/rng.js.',
  '    const rng = options.rng ?? Math.random;',
  ''
].join(NL);

const file = preamble + NL + body + NL + API;
writeFileSync('src/fluid/fluidCore.js', file);
console.log('wrote src/fluid/fluidCore.js (' + file.split(NL).length + ' lines)');
console.log('replaced ' + randomCount + ' Math.random() call(s) with the injected rng');
