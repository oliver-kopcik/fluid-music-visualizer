/**
 * One-shot tool: lift the GLSL sources out of vendor/script.js into src/fluid/shaders.js.
 *
 * Upstream declares every shader as `const X = compileShader(gl.TYPE, `...`)`, which welds
 * ~470 lines of GLSL to the GL context. We want the strings separately so fluidCore.js is
 * readable, but we do NOT want to retype them. Run this again if upstream is ever re-vendored.
 *
 *   node scripts/extract-shaders.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SHADER_BLOCK = { first: 440, last: 913 }; // 1-indexed, inclusive

const src = readFileSync('vendor/script.js', 'utf8');
const lines = src.split(/\r?\n/);
const block = lines.slice(SHADER_BLOCK.first - 1, SHADER_BLOCK.last).join('\n');

const header = lines.slice(0, 23).join('\n');

const shaders = [];
// GLSL contains no backticks, so [^`]* bounds each source exactly. A lazy [\s\S]*? does
// NOT work: advectionShader closes its template on the `}` line and passes a third
// `keywords` argument, so a lazy match runs on into the following shader.
const compiled = /const (\w+) = compileShader\((gl\.\w+),\s*`([^`]*)`\s*(,[\s\S]*?)?\);/g;
for (const m of block.matchAll(compiled)) {
  const extraArgs = (m[4] || '').replace(/^,\s*/, '').replace(/\s*$/, '');
  shaders.push({ name: m[1], glType: m[2], source: m[3], extraArgs, compiled: true });
}
const bare = /const (\w+) = `([^`]*)`;/g;
for (const m of block.matchAll(bare)) {
  if (shaders.some((s) => s.name === m[1])) continue;
  shaders.push({ name: m[1], glType: null, source: m[2], extraArgs: '', compiled: false });
}

// A `${` in a source would silently become an interpolation when re-emitted.
for (const s of shaders) {
  if (s.source.includes('${') || s.source.includes('`')) {
    throw new Error(`shader ${s.name} contains template syntax; needs escaping`);
  }
}

const covered = shaders.reduce((n, s) => n + s.source.split('\n').length, 0);
console.log(`extracted ${shaders.length} shaders, ${covered} lines of GLSL`);

const out = [
  header,
  '',
  '// GLSL sources lifted verbatim from vendor/script.js by scripts/extract-shaders.mjs.',
  '// Not hand-edited: new shaders go at the bottom of this file, existing ones stay as upstream wrote them.',
  '',
  ...shaders.map((s) => {
    const exportName = s.compiled ? `${s.name}Source` : s.name;
    return `export const ${exportName} = \`${s.source}\`;\n`;
  })
].join('\n');

writeFileSync('src/fluid/shaders.js', out);

// The compileShader() call sites fluidCore.js needs, so we don't retype those either.
const callSites = shaders
  .filter((s) => s.compiled)
  .map((s) =>
    s.extraArgs
      ? `const ${s.name} = compileShader(${s.glType}, ${s.name}Source, ${s.extraArgs});`
      : `const ${s.name} = compileShader(${s.glType}, ${s.name}Source);`
  )
  .join('\n');
writeFileSync('scripts/.shader-callsites.txt', callSites + '\n');

const importNames = shaders.map((s) => (s.compiled ? `${s.name}Source` : s.name));
writeFileSync('scripts/.shader-imports.txt', importNames.join(',\n  ') + '\n');
console.log('wrote src/fluid/shaders.js');
