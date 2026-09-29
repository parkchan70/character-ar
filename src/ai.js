import { pipeline, env, RawImage } from "@huggingface/transformers";

env.allowLocalModels = false;

// RMBG-1.4: general subject cut-out (people, animals, toys, illustrations).
// Free for non-commercial use (bria-rmbg-1.4 license).
const BG_MODEL = "briaai/RMBG-1.4";
const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
const INFER_MAX_SIDE = 1024; // both models resize internally; no gain feeding more

let removerPromise = null;
let depthPromise = null;

/**
 * Cuts the character out and estimates its depth, both at working resolution.
 *
 * @param {HTMLImageElement} image
 * @param {number} maxSize - working resolution (long side, px)
 * @param {(text: string) => void} onStatus
 * @returns {Promise<{width: number, height: number, alpha: Uint8Array, depth: Float32Array}>}
 *   alpha 0..255 (255 = character), depth 0..1 (1 = nearest)
 */
export async function analyzeCharacter(image, maxSize, onStatus) {
  const progress = trackDownloads(onStatus);
  removerPromise ??= pipeline("background-removal", BG_MODEL, { dtype: "q8", progress_callback: progress });
  depthPromise ??= pipeline("depth-estimation", DEPTH_MODEL, { dtype: "q8", progress_callback: progress });
  const [remover, depthEstimator] = await Promise.all([removerPromise, depthPromise]);

  const input = RawImage.fromCanvas(rasterize(image, INFER_MAX_SIDE));

  onStatus("배경을 지우는 중...");
  const cut = await remover(input);
  const cutImage = Array.isArray(cut) ? cut[0] : cut; // RGBA, alpha = character

  onStatus("입체감을 읽는 중...");
  const { depth } = await depthEstimator(input);

  const srcW = input.width, srcH = input.height;
  const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
  const W = Math.max(1, Math.round(srcW * scale));
  const H = Math.max(1, Math.round(srcH * scale));

  const alpha = resample(cutImage, 3, W, H);
  const depthSmall = resample(depth, 0, W, H);
  const depth01 = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) depth01[i] = depthSmall[i] / 255;

  return { width: W, height: H, alpha, depth: depth01 };
}

function rasterize(image, maxSide) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext("2d").drawImage(image, 0, 0, c.width, c.height);
  return c;
}

/** Box-downsamples one channel of a RawImage to W×H. */
function resample(raw, channel, W, H) {
  const { data, width: sw, height: sh, channels } = raw;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * sh) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * sw) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / W));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) { sum += data[(yy * sw + xx) * channels + channel]; n++; }
      }
      out[y * W + x] = sum / n;
    }
  }
  return out;
}

/** Combines per-file download progress of both models into one percentage. */
function trackDownloads(onStatus) {
  const files = new Map();
  return (p) => {
    if (p?.status === "progress" && p.file && p.total) {
      files.set(p.name + "/" + p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      onStatus(`AI 모델 받는 중... ${Math.round((100 * loaded) / total)}% (처음 한 번만)`);
    }
  };
}
