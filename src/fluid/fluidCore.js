/*
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/*
 * Derived from vendor/script.js by scripts/build-core.mjs.
 *
 * The simulation math and GLSL are Pavel Dobryakov's, unchanged. This file differs from
 * upstream only structurally: it takes the canvas as an argument, takes its RNG and dt
 * from the caller, exposes sizing explicitly, and owns no DOM events, GUI or rAF loop.
 * Run `npm run verify:core` to see that diff.
 *
 * Do not add visual behaviour here. Audio-driven behaviour belongs in src/mapping/.
 */

import {
  baseVertexShaderSource,
  blurVertexShaderSource,
  blurShaderSource,
  copyShaderSource,
  clearShaderSource,
  colorShaderSource,
  checkerboardShaderSource,
  bloomPrefilterShaderSource,
  bloomBlurShaderSource,
  bloomFinalShaderSource,
  sunraysMaskShaderSource,
  sunraysShaderSource,
  splatShaderSource,
  advectionShaderSource,
  divergenceShaderSource,
  curlShaderSource,
  vorticityShaderSource,
  pressureShaderSource,
  gradientSubtractShaderSource,
  displayShaderSource
} from './shaders.js';
import ditheringTextureUrl from './LDR_LLL1_0.png?url';

const DEFAULT_CONFIG = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLORFUL: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    BLOOM: true,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.8,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: true,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 1.0,
};

export { DEFAULT_CONFIG };

export function createFluidSim (canvas, options = {}) {
    // Seedable so a track always renders the same way. See src/util/rng.js.
    const rng = options.rng ?? Math.random;

    // Simulation section

    // BACK_COLOR is cloned so two sims never share one object.
    const config = Object.assign({}, DEFAULT_CONFIG, {
        BACK_COLOR: Object.assign({}, DEFAULT_CONFIG.BACK_COLOR)
    }, options.config);

    function pointerPrototype () {
        this.id = -1;
        this.texcoordX = 0;
        this.texcoordY = 0;
        this.prevTexcoordX = 0;
        this.prevTexcoordY = 0;
        this.deltaX = 0;
        this.deltaY = 0;
        this.down = false;
        this.moved = false;
        this.color = [30, 0, 300];
    }

    let pointers = [];
    let splatStack = [];
    pointers.push(new pointerPrototype());

    const { gl, ext } = getWebGLContext(canvas);

    if (isMobile()) {
        config.DYE_RESOLUTION = 512;
    }
    if (!ext.supportLinearFiltering) {
        config.DYE_RESOLUTION = 512;
        config.SHADING = false;
        config.BLOOM = false;
        config.SUNRAYS = false;
    }

    function getWebGLContext (canvas) {
        const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

        let gl = canvas.getContext('webgl2', params);
        const isWebGL2 = !!gl;
        if (!isWebGL2)
            gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

        let halfFloat;
        let supportLinearFiltering;
        if (isWebGL2) {
            gl.getExtension('EXT_color_buffer_float');
            supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
        } else {
            halfFloat = gl.getExtension('OES_texture_half_float');
            supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
        }

        gl.clearColor(0.0, 0.0, 0.0, 1.0);

        const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
        let formatRGBA;
        let formatRG;
        let formatR;

        if (isWebGL2)
        {
            formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
            formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
            formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
        }
        else
        {
            formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        }

        return {
            gl,
            ext: {
                formatRGBA,
                formatRG,
                formatR,
                halfFloatTexType,
                supportLinearFiltering
            }
        };
    }

    function getSupportedFormat (gl, internalFormat, format, type)
    {
        if (!supportRenderTextureFormat(gl, internalFormat, format, type))
        {
            switch (internalFormat)
            {
                case gl.R16F:
                    return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
                case gl.RG16F:
                    return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
                default:
                    return null;
            }
        }

        return {
            internalFormat,
            format
        }
    }

    function supportRenderTextureFormat (gl, internalFormat, format, type) {
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

        let fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        return status == gl.FRAMEBUFFER_COMPLETE;
    }

    function isMobile () {
        return /Mobi|Android/i.test(navigator.userAgent);
    }

    function framebufferToTexture (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        let length = target.width * target.height * 4;
        let texture = new Float32Array(length);
        gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
        return texture;
    }

    function normalizeTexture (texture, width, height) {
        let result = new Uint8Array(texture.length);
        let id = 0;
        for (let i = height - 1; i >= 0; i--) {
            for (let j = 0; j < width; j++) {
                let nid = i * width * 4 + j * 4;
                result[nid + 0] = clamp01(texture[id + 0]) * 255;
                result[nid + 1] = clamp01(texture[id + 1]) * 255;
                result[nid + 2] = clamp01(texture[id + 2]) * 255;
                result[nid + 3] = clamp01(texture[id + 3]) * 255;
                id += 4;
            }
        }
        return result;
    }

    function clamp01 (input) {
        return Math.min(Math.max(input, 0), 1);
    }

    function textureToCanvas (texture, width, height) {
        let captureCanvas = document.createElement('canvas');
        let ctx = captureCanvas.getContext('2d');
        captureCanvas.width = width;
        captureCanvas.height = height;

        let imageData = ctx.createImageData(width, height);
        imageData.data.set(texture);
        ctx.putImageData(imageData, 0, 0);

        return captureCanvas;
    }

    class Material {
        constructor (vertexShader, fragmentShaderSource) {
            this.vertexShader = vertexShader;
            this.fragmentShaderSource = fragmentShaderSource;
            this.programs = [];
            this.activeProgram = null;
            this.uniforms = [];
        }

        setKeywords (keywords) {
            let hash = 0;
            for (let i = 0; i < keywords.length; i++)
                hash += hashCode(keywords[i]);

            let program = this.programs[hash];
            if (program == null)
            {
                let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
                program = createProgram(this.vertexShader, fragmentShader);
                this.programs[hash] = program;
            }

            if (program == this.activeProgram) return;

            this.uniforms = getUniforms(program);
            this.activeProgram = program;
        }

        bind () {
            gl.useProgram(this.activeProgram);
        }
    }

    class Program {
        constructor (vertexShader, fragmentShader) {
            this.uniforms = {};
            this.program = createProgram(vertexShader, fragmentShader);
            this.uniforms = getUniforms(this.program);
        }

        bind () {
            gl.useProgram(this.program);
        }
    }

    function createProgram (vertexShader, fragmentShader) {
        let program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            console.trace(gl.getProgramInfoLog(program));

        return program;
    }

    function getUniforms (program) {
        let uniforms = [];
        let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniformCount; i++) {
            let uniformName = gl.getActiveUniform(program, i).name;
            uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
        }
        return uniforms;
    }

    function compileShader (type, source, keywords) {
        source = addKeywords(source, keywords);

        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            console.trace(gl.getShaderInfoLog(shader));

        return shader;
    };

    function addKeywords (source, keywords) {
        if (keywords == null) return source;
        let keywordsString = '';
        keywords.forEach(keyword => {
            keywordsString += '#define ' + keyword + '\n';
        });
        return keywordsString + source;
    }

    // Shader sources live in ./shaders.js. Compilation stays here because it needs `gl`.
    const baseVertexShader = compileShader(gl.VERTEX_SHADER, baseVertexShaderSource);
    const blurVertexShader = compileShader(gl.VERTEX_SHADER, blurVertexShaderSource);
    const blurShader = compileShader(gl.FRAGMENT_SHADER, blurShaderSource);
    const copyShader = compileShader(gl.FRAGMENT_SHADER, copyShaderSource);
    const clearShader = compileShader(gl.FRAGMENT_SHADER, clearShaderSource);
    const colorShader = compileShader(gl.FRAGMENT_SHADER, colorShaderSource);
    const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, checkerboardShaderSource);
    const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, bloomPrefilterShaderSource);
    const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, bloomBlurShaderSource);
    const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, bloomFinalShaderSource);
    const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, sunraysMaskShaderSource);
    const sunraysShader = compileShader(gl.FRAGMENT_SHADER, sunraysShaderSource);
    const splatShader = compileShader(gl.FRAGMENT_SHADER, splatShaderSource);
    const advectionShader = compileShader(gl.FRAGMENT_SHADER, advectionShaderSource, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']);
    const divergenceShader = compileShader(gl.FRAGMENT_SHADER, divergenceShaderSource);
    const curlShader = compileShader(gl.FRAGMENT_SHADER, curlShaderSource);
    const vorticityShader = compileShader(gl.FRAGMENT_SHADER, vorticityShaderSource);
    const pressureShader = compileShader(gl.FRAGMENT_SHADER, pressureShaderSource);
    const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, gradientSubtractShaderSource);

    const blit = (() => {
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        return (target, clear = false) => {
            if (target == null)
            {
                gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            }
            else
            {
                gl.viewport(0, 0, target.width, target.height);
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            }
            if (clear)
            {
                gl.clearColor(0.0, 0.0, 0.0, 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            // CHECK_FRAMEBUFFER_STATUS();
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        }
    })();

    function CHECK_FRAMEBUFFER_STATUS () {
        let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status != gl.FRAMEBUFFER_COMPLETE)
            console.trace("Framebuffer error: " + status);
    }

    let dye;
    let velocity;
    let divergence;
    let curl;
    let pressure;
    let bloom;
    let bloomFramebuffers = [];
    let sunrays;
    let sunraysTemp;

    let ditheringTexture = createTextureAsync(ditheringTextureUrl);

    const blurProgram            = new Program(blurVertexShader, blurShader);
    const copyProgram            = new Program(baseVertexShader, copyShader);
    const clearProgram           = new Program(baseVertexShader, clearShader);
    const colorProgram           = new Program(baseVertexShader, colorShader);
    const checkerboardProgram    = new Program(baseVertexShader, checkerboardShader);
    const bloomPrefilterProgram  = new Program(baseVertexShader, bloomPrefilterShader);
    const bloomBlurProgram       = new Program(baseVertexShader, bloomBlurShader);
    const bloomFinalProgram      = new Program(baseVertexShader, bloomFinalShader);
    const sunraysMaskProgram     = new Program(baseVertexShader, sunraysMaskShader);
    const sunraysProgram         = new Program(baseVertexShader, sunraysShader);
    const splatProgram           = new Program(baseVertexShader, splatShader);
    const advectionProgram       = new Program(baseVertexShader, advectionShader);
    const divergenceProgram      = new Program(baseVertexShader, divergenceShader);
    const curlProgram            = new Program(baseVertexShader, curlShader);
    const vorticityProgram       = new Program(baseVertexShader, vorticityShader);
    const pressureProgram        = new Program(baseVertexShader, pressureShader);
    const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

    const displayMaterial = new Material(baseVertexShader, displayShaderSource);

    function initFramebuffers () {
        let simRes = getResolution(config.SIM_RESOLUTION);
        let dyeRes = getResolution(config.DYE_RESOLUTION);

        const texType = ext.halfFloatTexType;
        const rgba    = ext.formatRGBA;
        const rg      = ext.formatRG;
        const r       = ext.formatR;
        const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        gl.disable(gl.BLEND);

        if (dye == null)
            dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
        else
            dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

        if (velocity == null)
            velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
        else
            velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

        divergence = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
        curl       = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
        pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

        initBloomFramebuffers();
        initSunraysFramebuffers();
    }

    function initBloomFramebuffers () {
        let res = getResolution(config.BLOOM_RESOLUTION);

        const texType = ext.halfFloatTexType;
        const rgba = ext.formatRGBA;
        const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

        bloomFramebuffers.length = 0;
        for (let i = 0; i < config.BLOOM_ITERATIONS; i++)
        {
            let width = res.width >> (i + 1);
            let height = res.height >> (i + 1);

            if (width < 2 || height < 2) break;

            let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
            bloomFramebuffers.push(fbo);
        }
    }

    function initSunraysFramebuffers () {
        let res = getResolution(config.SUNRAYS_RESOLUTION);

        const texType = ext.halfFloatTexType;
        const r = ext.formatR;
        const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        sunrays     = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
        sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    }

    function createFBO (w, h, internalFormat, format, type, param) {
        gl.activeTexture(gl.TEXTURE0);
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

        let fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        let texelSizeX = 1.0 / w;
        let texelSizeY = 1.0 / h;

        return {
            texture,
            fbo,
            width: w,
            height: h,
            texelSizeX,
            texelSizeY,
            attach (id) {
                gl.activeTexture(gl.TEXTURE0 + id);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return id;
            }
        };
    }

    function createDoubleFBO (w, h, internalFormat, format, type, param) {
        let fbo1 = createFBO(w, h, internalFormat, format, type, param);
        let fbo2 = createFBO(w, h, internalFormat, format, type, param);

        return {
            width: w,
            height: h,
            texelSizeX: fbo1.texelSizeX,
            texelSizeY: fbo1.texelSizeY,
            get read () {
                return fbo1;
            },
            set read (value) {
                fbo1 = value;
            },
            get write () {
                return fbo2;
            },
            set write (value) {
                fbo2 = value;
            },
            swap () {
                let temp = fbo1;
                fbo1 = fbo2;
                fbo2 = temp;
            }
        }
    }

    function resizeFBO (target, w, h, internalFormat, format, type, param) {
        let newFBO = createFBO(w, h, internalFormat, format, type, param);
        copyProgram.bind();
        gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
        blit(newFBO);
        return newFBO;
    }

    function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
        if (target.width == w && target.height == h)
            return target;
        target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
        target.write = createFBO(w, h, internalFormat, format, type, param);
        target.width = w;
        target.height = h;
        target.texelSizeX = 1.0 / w;
        target.texelSizeY = 1.0 / h;
        return target;
    }

    function createTextureAsync (url) {
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));

        let obj = {
            texture,
            width: 1,
            height: 1,
            attach (id) {
                gl.activeTexture(gl.TEXTURE0 + id);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return id;
            }
        };
        let resolveReady;
        obj.ready = new Promise(resolve => { resolveReady = resolve; });

        let image = new Image();
        image.onload = () => {
            obj.width = image.width;
            obj.height = image.height;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
            resolveReady(obj);
        };
        // Resolve on error too — a missing dithering texture degrades sunrays, it must not hang.
        image.onerror = () => resolveReady(obj);
        image.src = url;

        return obj;
    }

    function updateKeywords () {
        let displayKeywords = [];
        if (config.SHADING) displayKeywords.push("SHADING");
        if (config.BLOOM) displayKeywords.push("BLOOM");
        if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
        displayMaterial.setKeywords(displayKeywords);
    }

    updateKeywords();
    initFramebuffers();
    if (options.initialSplats)
        multipleSplats(options.initialSplats);

    let colorUpdateTimer = 0.0;

    function frame (dt) {
        updateColors(dt);
        applyInputs();
        if (!config.PAUSED)
            step(dt);
        render(null);
    }

    function setSize (width, height) {
        if (canvas.width === width && canvas.height === height)
            return false;
        canvas.width = width;
        canvas.height = height;
        initFramebuffers();
        return true;
    }

    function updateColors (dt) {
        if (!config.COLORFUL) return;

        colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
        if (colorUpdateTimer >= 1) {
            colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
            pointers.forEach(p => {
                p.color = generateColor();
            });
        }
    }

    function applyInputs () {
        if (splatStack.length > 0)
            multipleSplats(splatStack.pop());

        pointers.forEach(p => {
            if (p.moved) {
                p.moved = false;
                splatPointer(p);
            }
        });
    }

    function step (dt) {
        gl.disable(gl.BLEND);

        curlProgram.bind();
        gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
        gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
        blit(curl);

        vorticityProgram.bind();
        gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
        gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
        gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
        gl.uniform1f(vorticityProgram.uniforms.dt, dt);
        blit(velocity.write);
        velocity.swap();

        divergenceProgram.bind();
        gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
        gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
        blit(divergence);

        clearProgram.bind();
        gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
        gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
        blit(pressure.write);
        pressure.swap();

        pressureProgram.bind();
        gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
        gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
        for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
            blit(pressure.write);
            pressure.swap();
        }

        gradienSubtractProgram.bind();
        gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
        gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
        gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
        blit(velocity.write);
        velocity.swap();

        advectionProgram.bind();
        gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
        if (!ext.supportLinearFiltering)
            gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
        let velocityId = velocity.read.attach(0);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
        gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
        gl.uniform1f(advectionProgram.uniforms.dt, dt);
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
        blit(velocity.write);
        velocity.swap();

        if (!ext.supportLinearFiltering)
            gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
        blit(dye.write);
        dye.swap();
    }

    function render (target) {
        if (config.BLOOM)
            applyBloom(dye.read, bloom);
        if (config.SUNRAYS) {
            applySunrays(dye.read, dye.write, sunrays);
            blur(sunrays, sunraysTemp, 1);
        }

        if (target == null || !config.TRANSPARENT) {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.enable(gl.BLEND);
        }
        else {
            gl.disable(gl.BLEND);
        }

        if (!config.TRANSPARENT)
            drawColor(target, normalizeColor(config.BACK_COLOR));
        if (target == null && config.TRANSPARENT)
            drawCheckerboard(target);
        drawDisplay(target);
    }

    function drawColor (target, color) {
        colorProgram.bind();
        gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
        blit(target);
    }

    function drawCheckerboard (target) {
        checkerboardProgram.bind();
        gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
        blit(target);
    }

    function drawDisplay (target) {
        let width = target == null ? gl.drawingBufferWidth : target.width;
        let height = target == null ? gl.drawingBufferHeight : target.height;

        displayMaterial.bind();
        if (config.SHADING)
            gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
        gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
        if (config.BLOOM)
            gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let ditherTexScale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, ditherTexScale.x, ditherTexScale.y);
        if (config.SUNRAYS)
            gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
        blit(target);
    }

    function applyBloom (source, destination) {
        if (bloomFramebuffers.length < 2)
            return;

        let last = destination;

        gl.disable(gl.BLEND);
        bloomPrefilterProgram.bind();
        let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
        let curve0 = config.BLOOM_THRESHOLD - knee;
        let curve1 = knee * 2;
        let curve2 = 0.25 / knee;
        gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
        gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
        gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
        blit(last);

        bloomBlurProgram.bind();
        for (let i = 0; i < bloomFramebuffers.length; i++) {
            let dest = bloomFramebuffers[i];
            gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
            gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
            blit(dest);
            last = dest;
        }

        gl.blendFunc(gl.ONE, gl.ONE);
        gl.enable(gl.BLEND);

        for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
            let baseTex = bloomFramebuffers[i];
            gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
            gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
            gl.viewport(0, 0, baseTex.width, baseTex.height);
            blit(baseTex);
            last = baseTex;
        }

        gl.disable(gl.BLEND);
        bloomFinalProgram.bind();
        gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
        gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
        blit(destination);
    }

    function applySunrays (source, mask, destination) {
        gl.disable(gl.BLEND);
        sunraysMaskProgram.bind();
        gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
        blit(mask);

        sunraysProgram.bind();
        gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
        gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
        blit(destination);
    }

    function blur (target, temp, iterations) {
        blurProgram.bind();
        for (let i = 0; i < iterations; i++) {
            gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
            gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
            blit(temp);

            gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
            gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
            blit(target);
        }
    }

    function splatPointer (pointer) {
        let dx = pointer.deltaX * config.SPLAT_FORCE;
        let dy = pointer.deltaY * config.SPLAT_FORCE;
        splat(pointer.texcoordX, pointer.texcoordY, dx, dy, pointer.color);
    }

    function multipleSplats (amount) {
        for (let i = 0; i < amount; i++) {
            const color = generateColor();
            color.r *= 10.0;
            color.g *= 10.0;
            color.b *= 10.0;
            const x = rng();
            const y = rng();
            const dx = 1000 * (rng() - 0.5);
            const dy = 1000 * (rng() - 0.5);
            splat(x, y, dx, dy, color);
        }
    }

    function splat (x, y, dx, dy, color) {
        if (options.onSplat) options.onSplat(x, y, dx, dy, color);
        splatProgram.bind();
        gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
        gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
        gl.uniform2f(splatProgram.uniforms.point, x, y);
        gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
        gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
        blit(velocity.write);
        velocity.swap();

        gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
        gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
        blit(dye.write);
        dye.swap();
    }

    function correctRadius (radius) {
        let aspectRatio = canvas.width / canvas.height;
        if (aspectRatio > 1)
            radius *= aspectRatio;
        return radius;
    }

    // Pointer entry points. Upstream bound these straight to DOM events; as plain calls
    // they let the export path guarantee no stray input contaminates a render.
    function pointerDown (id, posX, posY) {
        let pointer = pointers.find(p => p.id == id);
        if (pointer == null) {
            pointer = new pointerPrototype();
            pointers.push(pointer);
        }
        updatePointerDownData(pointer, id, posX, posY);
    }

    function pointerMove (id, posX, posY) {
        let pointer = pointers.find(p => p.id == id);
        if (pointer == null || !pointer.down) return;
        updatePointerMoveData(pointer, posX, posY);
    }

    function pointerUp (id) {
        let pointer = pointers.find(p => p.id == id);
        if (pointer == null) return;
        updatePointerUpData(pointer);
    }

    function pushRandomSplats (amount) {
        splatStack.push(amount);
    }

    function updatePointerDownData (pointer, id, posX, posY) {
        pointer.id = id;
        pointer.down = true;
        pointer.moved = false;
        pointer.texcoordX = posX / canvas.width;
        pointer.texcoordY = 1.0 - posY / canvas.height;
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.deltaX = 0;
        pointer.deltaY = 0;
        pointer.color = generateColor();
    }

    function updatePointerMoveData (pointer, posX, posY) {
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.texcoordX = posX / canvas.width;
        pointer.texcoordY = 1.0 - posY / canvas.height;
        pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
        pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
        pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
    }

    function updatePointerUpData (pointer) {
        pointer.down = false;
    }

    function correctDeltaX (delta) {
        let aspectRatio = canvas.width / canvas.height;
        if (aspectRatio < 1) delta *= aspectRatio;
        return delta;
    }

    function correctDeltaY (delta) {
        let aspectRatio = canvas.width / canvas.height;
        if (aspectRatio > 1) delta /= aspectRatio;
        return delta;
    }

    function generateColor () {
        let c = HSVtoRGB(rng(), 1.0, 1.0);
        c.r *= 0.15;
        c.g *= 0.15;
        c.b *= 0.15;
        return c;
    }

    function HSVtoRGB (h, s, v) {
        let r, g, b, i, f, p, q, t;
        i = Math.floor(h * 6);
        f = h * 6 - i;
        p = v * (1 - s);
        q = v * (1 - f * s);
        t = v * (1 - (1 - f) * s);

        switch (i % 6) {
            case 0: r = v, g = t, b = p; break;
            case 1: r = q, g = v, b = p; break;
            case 2: r = p, g = v, b = t; break;
            case 3: r = p, g = q, b = v; break;
            case 4: r = t, g = p, b = v; break;
            case 5: r = v, g = p, b = q; break;
        }

        return {
            r,
            g,
            b
        };
    }

    function normalizeColor (input) {
        let output = {
            r: input.r / 255,
            g: input.g / 255,
            b: input.b / 255
        };
        return output;
    }

    function wrap (value, min, max) {
        let range = max - min;
        if (range == 0) return min;
        return (value - min) % range + min;
    }

    function getResolution (resolution) {
        let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
        if (aspectRatio < 1)
            aspectRatio = 1.0 / aspectRatio;

        let min = Math.round(resolution);
        let max = Math.round(resolution * aspectRatio);

        if (gl.drawingBufferWidth > gl.drawingBufferHeight)
            return { width: max, height: min };
        else
            return { width: min, height: max };
    }

    function getTextureScale (texture, width, height) {
        return {
            x: width / texture.width,
            y: height / texture.height
        };
    }

    function hashCode (s) {
        if (s.length == 0) return 0;
        let hash = 0;
        for (let i = 0; i < s.length; i++) {
            hash = (hash << 5) - hash + s.charCodeAt(i);
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    };

    const ready = Promise.all([ditheringTexture.ready]);

    const FRAMEBUFFER_KEYS = new Set([
        'SIM_RESOLUTION', 'DYE_RESOLUTION', 'BLOOM_RESOLUTION', 'SUNRAYS_RESOLUTION'
    ]);
    const KEYWORD_KEYS = new Set(['SHADING', 'BLOOM', 'SUNRAYS']);

    // Writing a framebuffer key reallocates every texture and wipes the dye, so the two
    // setters are kept apart: setConfig absorbs that cost, setConfigFast refuses to pay it.
    function setConfig (patch) {
        let resize = false;
        let keywords = false;
        for (const key in patch) {
            if (config[key] === patch[key]) continue;
            config[key] = patch[key];
            if (FRAMEBUFFER_KEYS.has(key)) resize = true;
            if (KEYWORD_KEYS.has(key)) keywords = true;
        }
        if (keywords) updateKeywords();
        if (resize) initFramebuffers();
    }

    function setConfigFast (patch) {
        for (const key in patch) {
            if (FRAMEBUFFER_KEYS.has(key) || KEYWORD_KEYS.has(key))
                throw new Error('setConfigFast: ' + key + ' reallocates framebuffers; use setConfig');
            config[key] = patch[key];
        }
    }

    function readTarget (target) {
        let texture = framebufferToTexture(target);
        texture = normalizeTexture(texture, target.width, target.height);
        return { data: texture, width: target.width, height: target.height };
    }

    function captureTarget () {
        let res = getResolution(config.CAPTURE_RESOLUTION);
        let target = createFBO(res.width, res.height, ext.formatRGBA.internalFormat,
                               ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);
        render(target);
        const out = readTarget(target);
        return textureToCanvas(out.data, out.width, out.height);
    }

    // Reallocating the framebuffers is how upstream zeroes dye and velocity.
    function clear () {
        initFramebuffers();
    }

    function dispose () {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
    }

    return {
        canvas, gl, ext, config, ready,
        setConfig, setConfigFast, setSize,
        initFramebuffers, updateKeywords,
        frame, step, render, updateColors, applyInputs,
        splat, splatPointer, multipleSplats, pushRandomSplats,
        pointers, pointerDown, pointerMove, pointerUp,
        correctRadius, generateColor, HSVtoRGB,
        readTarget, captureTarget, clear, dispose
    };
}
