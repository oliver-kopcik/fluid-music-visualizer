/**
 * Simulation controls, replacing upstream's dat.gui panel.
 *
 * Every control writes through sim.setConfig rather than mutating sim.config directly.
 * That is what upstream's scattered `.onFinishChange(initFramebuffers)` calls were doing
 * by hand; centralising it means a control can never forget to reallocate framebuffers
 * or recompile the display shader's keywords.
 */
import GUI from 'lil-gui';

export function createSimGUI(sim, { onScreenshot, getMapping } = {}) {
  const gui = new GUI({ width: 300, title: 'Simulation' });
  const set = (key) => (value) => sim.setConfig({ [key]: value });

  gui.add(sim.config, 'DYE_RESOLUTION', { high: 1024, medium: 512, low: 256, 'very low': 128 })
    .name('quality')
    .onFinishChange(set('DYE_RESOLUTION'));
  gui.add(sim.config, 'SIM_RESOLUTION', { 32: 32, 64: 64, 128: 128, 256: 256 })
    .name('sim resolution')
    .onFinishChange(set('SIM_RESOLUTION'));
  /**
   * .listen() on everything the mapping drives.
   *
   * Without it these sliders show whatever they were last set to while the actual values
   * are being swept every frame, so the panel quietly lies about what the simulation is
   * doing. Ranges are widened to match what FEEL can actually produce — upstream's
   * vorticity slider stops at 50 and the mapping legitimately goes past it.
   */
  gui.add(sim.config, 'DENSITY_DISSIPATION', 0, 30).name('density diffusion').listen();
  gui.add(sim.config, 'VELOCITY_DISSIPATION', 0, 1.6).name('velocity diffusion').listen();
  gui.add(sim.config, 'PRESSURE', 0.3, 1).name('pressure').listen();
  gui.add(sim.config, 'CURL', 0, 90).step(1).name('vorticity').listen();
  gui.add(sim.config, 'SPLAT_RADIUS', 0.01, 0.9).name('splat radius').listen();
  gui.add(sim.config, 'SHADING').name('shading').onChange(set('SHADING'));
  gui.add(sim.config, 'COLORFUL').name('colorful');
  gui.add(sim.config, 'PAUSED').name('paused').listen();
  gui.add({ splat: () => sim.pushRandomSplats(12) }, 'splat').name('random splats');

  const bloom = gui.addFolder('Bloom');
  bloom.add(sim.config, 'BLOOM').name('enabled').onChange(set('BLOOM'));
  bloom.add(sim.config, 'BLOOM_INTENSITY', 0.1, 1.6).name('intensity').listen();
  bloom.add(sim.config, 'BLOOM_THRESHOLD', 0, 1).name('threshold').listen();

  const sunrays = gui.addFolder('Sunrays');
  sunrays.add(sim.config, 'SUNRAYS').name('enabled').onChange(set('SUNRAYS'));
  sunrays.add(sim.config, 'SUNRAYS_WEIGHT', 0.1, 2).name('weight').listen();

  const capture = gui.addFolder('Capture');
  capture.addColor(sim.config, 'BACK_COLOR').name('background color');
  capture.add(sim.config, 'TRANSPARENT').name('transparent');
  if (onScreenshot) capture.add({ shot: onScreenshot }, 'shot').name('take screenshot');

  if (getMapping) {
    // Read-outs, so it is visible which section character is driving the sliders above.
    const live = { atmosphere: '-', posture: '-' };
    const arcFolder = gui.addFolder('Arc');
    arcFolder.add(live, 'atmosphere').name('atmosphere').listen().disable();
    arcFolder.add(live, 'posture').name('posture').listen().disable();
    setInterval(() => {
      const m = getMapping();
      if (!m) return;
      live.atmosphere = m.atmosphereName ?? '-';
      live.posture = m.arc?.posture ?? '-';
    }, 120);

    const sync = { offset: 0.045 };
    gui
      .add(sync, 'offset', -0.25, 0.25, 0.005)
      .name('a/v sync (s)')
      .onChange((v) => {
        const m = getMapping();
        if (m) m.syncOffset = v;
      });
  }

  gui.close();
  return gui;
}
