/**
 * Character mask from the background-removal alpha, split into tappable
 * regions so the user can fix mistakes:
 *  - islands: separate pieces the model kept (the character, stray bits)
 *  - holes:   background enclosed by the character (e.g. between arm and body)
 * By default the big pieces are kept and enclosed background stays removed.
 *
 * @param {{width: number, height: number, alpha: Uint8Array}} analysis
 */
export function makeCutout({ width: W, height: H, alpha }) {
  const N = W * H;
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = alpha[i] >= 128 ? 1 : 0;

  const isl = labelRegions(fg, W, H, 1);
  const hol = labelRegions(fg, W, H, 0);
  const largest = Math.max(0, ...isl.regions.map((r) => r.area));
  if (largest < N * 0.005) {
    throw new Error("이미지에서 캐릭터를 찾지 못했어요. 캐릭터가 크게 나온 이미지를 올려주세요.");
  }

  const cut = {
    width: W,
    height: H,
    islandLabels: isl.labels,
    // Small crumbs from the matting edge are dropped; real parts stay.
    islands: isl.regions.map((r) => ({ area: r.area, on: r.area >= 0.1 * largest })),
    holeLabels: hol.labels,
    holes: hol.regions.map((r) => ({ area: r.area, toggleable: !r.touchesBorder, on: false })),
    mask: null,
  };
  rebuildMask(cut);
  return cut;
}

/** Toggles the region nearest to (x, y) in working pixels. Returns true if changed. */
export function toggleRegionAt(cut, x, y) {
  const { width: W, height: H } = cut;
  const cx = Math.round(x), cy = Math.round(y);
  const reach = Math.max(2, Math.round(Math.max(W, H) / 80));
  let best = null, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = cx + dx, py = cy + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = py * W + px, d = dx * dx + dy * dy;
      if (d >= bestD) continue;
      if (cut.islandLabels[i] >= 0) { best = cut.islands[cut.islandLabels[i]]; bestD = d; }
      else if (cut.holeLabels[i] >= 0 && cut.holes[cut.holeLabels[i]].toggleable) {
        best = cut.holes[cut.holeLabels[i]]; bestD = d;
      }
    }
  }
  if (!best) return false;
  best.on = !best.on;
  rebuildMask(cut);
  return true;
}

/** True where a pixel belongs to a region the user could tap back in. */
export function isRestorable(cut, i) {
  if (cut.mask[i]) return false;
  const il = cut.islandLabels[i];
  if (il >= 0) return true;
  const hl = cut.holeLabels[i];
  return hl >= 0 && cut.holes[hl].toggleable;
}

function rebuildMask(cut) {
  const { width: W, height: H, islandLabels, islands, holeLabels, holes } = cut;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const il = islandLabels[i], hl = holeLabels[i];
    mask[i] = (il >= 0 && islands[il].on) || (hl >= 0 && holes[hl].on) ? 1 : 0;
  }
  cut.mask = mask;
}

/** Labels 4-connected regions where m[i] === value. */
function labelRegions(m, W, H, value) {
  const labels = new Int32Array(W * H).fill(-1);
  const regions = [];
  const queue = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (m[start] !== value || labels[start] !== -1) continue;
    const id = regions.length;
    let head = 0, tail = 0, area = 0, touchesBorder = false;
    queue[tail++] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++];
      area++;
      const x = i % W, y = (i / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesBorder = true;
      if (x > 0 && m[i - 1] === value && labels[i - 1] === -1) { labels[i - 1] = id; queue[tail++] = i - 1; }
      if (x < W - 1 && m[i + 1] === value && labels[i + 1] === -1) { labels[i + 1] = id; queue[tail++] = i + 1; }
      if (y > 0 && m[i - W] === value && labels[i - W] === -1) { labels[i - W] = id; queue[tail++] = i - W; }
      if (y < H - 1 && m[i + W] === value && labels[i + W] === -1) { labels[i + W] = id; queue[tail++] = i + W; }
    }
    regions.push({ area, touchesBorder });
  }
  return { labels, regions };
}
