/**
 * PNG capture. The pixel side of this (render to an FBO, read back, normalise) stayed in
 * fluidCore as captureTarget(); only the browser download lives here.
 */

export function downloadCanvas(canvas, filename = 'fluid.png') {
  const uri = canvas.toDataURL();
  const link = document.createElement('a');
  link.download = filename;
  link.href = uri;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function captureScreenshot(sim, filename) {
  downloadCanvas(sim.captureTarget(), filename);
}
