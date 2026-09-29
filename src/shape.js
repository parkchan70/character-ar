import { computeHeightField, distanceTransform, blur } from "./inflate.js";

const MAX_TEXTURE_SIDE = 2048;

/**
 * Front/back surface heights for a rendered character.
 * Front = rounded silhouette volume plus relief from the depth model (face,
 * arms, folds come forward). The relief fades out toward the outline so
 * front and back still meet cleanly. Back = the plain rounded volume.
 *
 * @returns {{zFront: Float32Array, zBack: Float32Array}} half-thickness per pixel
 */
export function characterShape(cut, depth, thickness) {
  const { mask, width: W, height: H } = cut;
  const N = W * H;
  const base = computeHeightField(mask, W, H, 1);

  let dMax = 0;
  for (let i = 0; i < N; i++) if (base[i] > dMax) dMax = base[i];

  // Depth is relative per image; normalize over the character only.
  const vals = [];
  for (let i = 0; i < N; i++) if (mask[i]) vals.push(depth[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.05)] ?? 0;
  const hi = vals[Math.floor(vals.length * 0.95)] ?? 1;
  const range = Math.max(1e-3, hi - lo);
  let mean = 0;
  for (const v of vals) mean += Math.min(1, Math.max(0, (v - lo) / range));
  mean /= vals.length || 1;

  const dist2 = distanceTransform(mask, W, H);
  const rimWidth = Math.max(2, dMax * 0.35);
  const relief = 0.8 * dMax;

  const zFront = new Float32Array(N);
  const zBack = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const dn = Math.min(1, Math.max(0, (depth[i] - lo) / range));
    const t = Math.min(1, Math.sqrt(dist2[i]) / rimWidth);
    const fade = t * t * (3 - 2 * t); // smoothstep
    const z = base[i] + fade * relief * (dn - mean);
    zFront[i] = thickness * Math.max(0.25 * base[i], z);
    zBack[i] = thickness * 0.85 * base[i];
  }
  // The depth model is a little noisy at mesh resolution.
  const r = Math.max(1, Math.round(Math.max(W, H) / 250));
  return { zFront: blur(zFront, W, H, r), zBack };
}

/**
 * Front texture: the image, with the area outside the character filled by
 * nearby character colors so no background bleeds onto the outline.
 * Back texture: heavily blurred character colors (hair stays hair-colored,
 * clothes stay clothes-colored) instead of a mirrored face.
 *
 * @returns {{front: HTMLCanvasElement, back: HTMLCanvasElement}}
 */
export function characterTextures(image, cut) {
  const { mask, width: W, height: H } = cut;
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  const s = Math.min(1, MAX_TEXTURE_SIDE / Math.max(srcW, srcH));
  const FW = Math.round(srcW * s), FH = Math.round(srcH * s);
  const canvas = () => {
    const c = document.createElement("canvas");
    c.width = FW;
    c.height = FH;
    return c;
  };

  const maskSmall = document.createElement("canvas");
  maskSmall.width = W;
  maskSmall.height = H;
  const md = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) md.data.set([255, 255, 255, mask[i] ? 255 : 0], i * 4);
  maskSmall.getContext("2d").putImageData(md, 0, 0);

  // Character only, transparent elsewhere.
  const masked = canvas();
  const mctx = masked.getContext("2d");
  mctx.drawImage(image, 0, 0, FW, FH);
  mctx.globalCompositeOperation = "destination-in";
  mctx.drawImage(maskSmall, 0, 0, FW, FH);

  // Blurring a transparent-outside image and reading it back (unpremultiplied)
  // averages only character pixels, so colors don't wash toward the background.
  const back = canvas();
  const bctx = back.getContext("2d", { willReadFrequently: true });
  bctx.filter = `blur(${Math.max(4, Math.round(Math.max(FW, FH) * 0.025))}px)`;
  bctx.drawImage(masked, 0, 0);
  bctx.drawImage(masked, 0, 0); // second pass reaches further past the outline
  bctx.filter = "none";
  const bd = bctx.getImageData(0, 0, FW, FH);
  for (let i = 3; i < bd.data.length; i += 4) bd.data[i] = 255;
  bctx.putImageData(bd, 0, 0);

  const front = canvas();
  const fctx = front.getContext("2d");
  fctx.drawImage(back, 0, 0);
  fctx.drawImage(masked, 0, 0);

  return { front, back };
}
