/** Contain the current scene without cropping or stretching, leaving caption space. */
export function fitPhoto(width: number, height: number) {
  const scale = Math.min(1200 / width, 700 / height);
  return { x: (1200 - width * scale) / 2, y: (700 - height * scale) / 2, width: width * scale, height: height * scale };
}
export function drawPhotoScene(context: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number) {
  const fit = fitPhoto(width, height);
  context.drawImage(source, fit.x, fit.y, fit.width, fit.height);
}
