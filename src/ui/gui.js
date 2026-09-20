/**
 * Simulation controls, replacing upstream's dat.gui panel.
 *
 * Every control writes through sim.setConfig rather than mutating sim.config directly.
 * That is what upstream's scattered `.onFinishChange(initFramebuffers)` calls were doing
 * by hand; centralising it means a control can never forget to reallocate framebuffers
 * or recompile the display shader's keywords.
 */
import GUI from 'lil-gui';

export function createSimGUI(sim, { onScreenshot } = {}) {
  const gui = new GUI({ width: 300, title: 'Simulation' });
  const set = (key) => (value) => sim.setConfig({ [key]: value });

  gui.add(sim.config, 'DYE_RESOLUTION', { high: 1024, medium: 512, low: 256, 'very low': 128 })
    .name('quality')
    .onFinishChange(set('DYE_RESOLUTION'));
  gui.add(sim.config, 'SIM_RESOLUTION', { 32: 32, 64: 64, 128: 128, 256: 256 })
    .name('sim resolution')
    .onFinishChange(set('SIM_RESOLUTION'));
  gui.add(sim.config, 'DENSITY_DISSIPATION', 0, 4).name('density diffusion');
  gui.add(sim.config, 'VELOCITY_DISSIPATION', 0, 4).name('velocity diffusion');
  gui.add(sim.config, 'PRESSURE', 0, 1).name('pressure');
  gui.add(sim.config, 'CURL', 0, 50).step(1).name('vorticity');
  gui.add(sim.config, 'SPLAT_RADIUS', 0.01, 1).name('splat radius');
  gui.add(sim.config, 'SHADING').name('shading').onChange(set('SHADING'));
  gui.add(sim.config, 'COLORFUL').name('colorful');
  gui.add(sim.config, 'PAUSED').name('paused').listen();
  gui.add({ splat: () => sim.pushRandomSplats(12) }, 'splat').name('random splats');

  const bloom = gui.addFolder('Bloom');
  bloom.add(sim.config, 'BLOOM').name('enabled').onChange(set('BLOOM'));
  bloom.add(sim.config, 'BLOOM_INTENSITY', 0.1, 2).name('intensity');
  bloom.add(sim.config, 'BLOOM_THRESHOLD', 0, 1).name('threshold');

  const sunrays = gui.addFolder('Sunrays');
  sunrays.add(sim.config, 'SUNRAYS').name('enabled').onChange(set('SUNRAYS'));
  sunrays.add(sim.config, 'SUNRAYS_WEIGHT', 0.3, 1).name('weight');

  const capture = gui.addFolder('Capture');
  capture.addColor(sim.config, 'BACK_COLOR').name('background color');
  capture.add(sim.config, 'TRANSPARENT').name('transparent');
  if (onScreenshot) capture.add({ shot: onScreenshot }, 'shot').name('take screenshot');

  gui.close();
  return gui;
}
