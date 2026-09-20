# Notice

This project is built on top of **[WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)**
by Pavel Dobryakov, used under the MIT License. See [`LICENSE`](./LICENSE).

The pristine upstream sources are vendored unmodified in [`vendor/`](./vendor/) so that the
modularization diff in `src/fluid/` stays reviewable against them:

```
vendor/script.js        upstream fluid simulation (1645 lines)
vendor/index.html       upstream page
vendor/LDR_LLL1_0.png   sunrays dithering texture
vendor/LICENSE          upstream MIT license
```

`src/fluid/fluidCore.js` and `src/fluid/shaders.js` are derived from `vendor/script.js`.
The simulation math and GLSL are Pavel Dobryakov's work; the changes are structural
(ES module wrapper, injected RNG, explicit sizing, removed DOM/GUI coupling).
