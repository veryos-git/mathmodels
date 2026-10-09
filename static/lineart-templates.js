/** Editable line-art layers. Assets are embedded so library changes cannot
 * alter an existing image or a saved project. SVGs load as images, never DOM. */
export const TEMPLATE_FILE = /\.(svg|png)$/i;

export function templatePoint(layer, x, y) {
  const angle = layer.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [layer.x + x * c - y * s, layer.y + x * s + y * c];
}

export function templateLocalPoint(layer, [x, y]) {
  const angle = layer.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [(x - layer.x) * c + (y - layer.y) * s, -(x - layer.x) * s + (y - layer.y) * c];
}

export function templateHandles(layer, gap) {
  return [
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
      kind: 'resize', sx, sy, point: templatePoint(layer, sx * layer.width / 2, sy * layer.height / 2),
    })),
    { kind: 'rotate', point: templatePoint(layer, 0, -layer.height / 2 - gap) },
  ];
}

export function hitTemplate(layers, selected, point, radius) {
  const active = layers.find(layer => layer.id === selected);
  if (active) for (const handle of templateHandles(active, radius * 4)) {
    if (Math.hypot(point[0] - handle.point[0], point[1] - handle.point[1]) <= radius) {
      return { layer: active, ...handle };
    }
  }
  for (const layer of [...layers].reverse()) {
    const [x, y] = templateLocalPoint(layer, point);
    if (Math.abs(x) <= layer.width / 2 && Math.abs(y) <= layer.height / 2) return { layer, kind: 'move' };
  }
  return null;
}

/** Resize around the opposite corner; all pointer coordinates are image pixels. */
export function transformTemplate(start, gesture, point, lockAspect = true) {
  if (gesture.kind === 'move') return { ...start,
    x: start.x + point[0] - gesture.start[0], y: start.y + point[1] - gesture.start[1] };
  if (gesture.kind === 'rotate') {
    const angle = Math.atan2(point[1] - start.y, point[0] - start.x);
    const initial = Math.atan2(gesture.start[1] - start.y, gesture.start[0] - start.x);
    return { ...start, rotation: start.rotation + (angle - initial) * 180 / Math.PI };
  }
  const anchor = templatePoint(start, -gesture.sx * start.width / 2, -gesture.sy * start.height / 2);
  const [x, y] = templateLocalPoint({ ...start, x: anchor[0], y: anchor[1] }, point);
  let width = Math.max(1, x * gesture.sx), height = Math.max(1, y * gesture.sy);
  if (lockAspect) {
    const scale = Math.max(1 / Math.min(start.width, start.height),
      (width * start.width + height * start.height) / (start.width ** 2 + start.height ** 2));
    width = start.width * scale; height = start.height * scale;
  }
  const [cx, cy] = templatePoint({ ...start, x: anchor[0], y: anchor[1] }, gesture.sx * width / 2, gesture.sy * height / 2);
  return { ...start, x: cx, y: cy, width, height };
}

export class LineArtTemplates {
  constructor() { this.items = []; this.assets = new Map(); this.selected = null; }
  clear() { this.items = []; this.assets.clear(); this.selected = null; }
  snapshot() { return this.items.map(({ image, ...layer }) => ({ ...layer })); }
  async asset(src) {
    if (!/^data:image\/(svg\+xml|png);base64,/.test(src)) throw new Error('Templates must be embedded SVG or PNG images.');
    if (this.assets.has(src)) return this.assets.get(src);
    const image = new Image();
    image.src = src;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The template has no image dimensions.');
    this.assets.set(src, image);
    return image;
  }
  async read(file) {
    if (!TEMPLATE_FILE.test(file.name)) throw new Error('Choose an SVG or PNG line-art template.');
    if (!file.size || file.size > 16 * 1024 * 1024) throw new Error('Templates must contain data and be at most 16 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const src = `data:image/${/\.svg$/i.test(file.name) ? 'svg+xml' : 'png'};base64,${btoa(binary)}`;
    return { src, image: await this.asset(src), name: file.name };
  }
  add(asset, width, height) {
    const scale = Math.min(width * .6 / asset.image.naturalWidth, height * .6 / asset.image.naturalHeight);
    const layer = { ...asset, id: crypto.randomUUID(), x: width / 2, y: height / 2,
      width: asset.image.naturalWidth * scale, height: asset.image.naturalHeight * scale, rotation: 0 };
    this.items.push(layer); this.selected = layer.id;
    return layer;
  }
  restore(snapshot = [], selected = null) {
    if (!Array.isArray(snapshot)) throw new Error('Invalid saved templates.');
    this.items = snapshot.map(layer => {
      if (!layer || !['x', 'y', 'width', 'height', 'rotation'].every(key => Number.isFinite(layer[key]))
          || layer.width <= 0 || layer.height <= 0 || !this.assets.has(layer.src)) throw new Error('Invalid saved template.');
      return { id: layer.id, name: layer.name, src: layer.src, x: layer.x, y: layer.y,
        width: layer.width, height: layer.height, rotation: layer.rotation, image: this.assets.get(layer.src) };
    });
    this.selected = this.items.some(layer => layer.id === selected) ? selected : this.items.at(-1)?.id ?? null;
  }
  async load(snapshot = []) {
    if (!Array.isArray(snapshot)) throw new Error('Invalid saved templates.');
    await Promise.all(snapshot.map(layer => this.asset(layer.src)));
    this.restore(snapshot);
  }
  draw(ctx, offsetX = 0, offsetY = 0) {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.globalCompositeOperation = 'multiply';
    for (const layer of this.items) {
      ctx.save();
      ctx.translate(layer.x, layer.y);
      ctx.rotate(layer.rotation * Math.PI / 180);
      ctx.drawImage(layer.image, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
      ctx.restore();
    }
    ctx.restore();
  }
}
