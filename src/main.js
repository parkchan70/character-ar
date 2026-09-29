import { analyzeCharacter } from "./ai.js";
import { makeCutout, toggleRegionAt, isRestorable } from "./cutout.js";
import { characterShape, characterTextures } from "./shape.js";
import { buildClosedMesh, disposeModel } from "./inflate.js";
import { PreviewScene } from "./previewScene.js";
import { setupArApp } from "./arApp.js";

const WORK_SIZE = 512;
const $ = (id) => document.getElementById(id);

const uploadBox = $("uploadBox");
const fileInput = $("fileInput");
const uploadPlaceholder = $("uploadPlaceholder");
const previewImg = $("previewImg");
const depthSlider = $("depthSlider");
const convertBtn = $("convertBtn");
const statusText = $("statusText");
const previewWrap = $("previewWrap");
const goArBtn = $("goArBtn");
const cutoutCanvas = $("cutoutCanvas");

let sourceImage = null; // HTMLImageElement
let analysis = null; // { width, height, alpha, depth } from the AI models
let cutout = null; // editable mask built from analysis.alpha
let textures = null; // { front, back } canvases
let modelGroup = null; // THREE.Group, lives in exactly one scene at a time

const preview = new PreviewScene($("previewCanvas"));
const ar = setupArApp({ preview, getModel: () => modelGroup, filePrefix: "character-ar" });

// ---------- Upload ----------
uploadBox.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  sourceImage = img;
  analysis = cutout = textures = null;
  previewImg.src = url;
  previewImg.hidden = false;
  uploadPlaceholder.hidden = true;
  convertBtn.disabled = false;
  previewWrap.hidden = true;
  goArBtn.disabled = true;
  statusText.textContent = "";
});

// ---------- Convert to 3D ----------
const thickness = () => 0.2 + (Number(depthSlider.value) / 100) * 1.2;

function rebuildModel({ resetView, maskChanged }) {
  if (maskChanged || !textures) textures = characterTextures(sourceImage, cutout);
  const { zFront, zBack } = characterShape(cutout, analysis.depth, thickness());
  const next = buildClosedMesh(cutout, zFront, zBack, textures.front, textures.back);
  const prev = modelGroup;
  modelGroup = next;
  preview.setModel(modelGroup, { resetView });
  if (prev) disposeModel(prev);
}

convertBtn.addEventListener("click", async () => {
  if (!sourceImage) return;
  convertBtn.disabled = true;
  const setStatus = (t) => (statusText.textContent = t);
  setStatus("AI 모델 준비 중... (처음 한 번은 1~2분 걸릴 수 있어요)");

  try {
    analysis = await analyzeCharacter(sourceImage, WORK_SIZE, setStatus);
    cutout = makeCutout(analysis);
    setStatus("입체로 만드는 중...");
    await new Promise((r) => setTimeout(r, 30)); // let the status text paint
    rebuildModel({ resetView: true, maskChanged: true });

    previewWrap.hidden = false;
    drawCutout();
    goArBtn.disabled = !ar.isArSupported();
    setStatus("완료! 아래 미리보기를 돌려서 앞뒤를 확인해보세요.");
  } catch (err) {
    console.error(err);
    setStatus("3D 변환 중 오류가 발생했어요: " + (err?.message || err));
  } finally {
    convertBtn.disabled = false;
  }
});

depthSlider.addEventListener("change", () => {
  if (modelGroup && cutout) rebuildModel({ resetView: false });
});

// ---------- Cut-out editor ----------
function drawCutout() {
  const { width: W, height: H, mask } = cutout;
  const small = document.createElement("canvas");
  small.width = W;
  small.height = H;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(sourceImage, 0, 0, W, H);
  const photo = sctx.getImageData(0, 0, W, H);

  cutoutCanvas.width = W;
  cutoutCanvas.height = H;
  const ctx = cutoutCanvas.getContext("2d");
  const cell = Math.max(6, Math.round(Math.max(W, H) / 40));
  for (let y = 0; y < H; y += cell) {
    for (let x = 0; x < W; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) & 1) ? "#2a2c36" : "#1d1f27";
      ctx.fillRect(x, y, cell, cell);
    }
  }

  const out = new ImageData(new Uint8ClampedArray(photo.data), W, H);
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) continue;
    // Removed but tappable back in: faint pink. Plain background: transparent.
    if (isRestorable(cutout, i)) out.data.set([255, 90, 130, 70], i * 4);
    else out.data[i * 4 + 3] = 0;
  }
  const layer = document.createElement("canvas");
  layer.width = W;
  layer.height = H;
  layer.getContext("2d").putImageData(out, 0, 0);
  ctx.drawImage(layer, 0, 0);
}

cutoutCanvas.addEventListener("click", (e) => {
  if (!cutout) return;
  const rect = cutoutCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * cutout.width;
  const y = ((e.clientY - rect.top) / rect.height) * cutout.height;
  if (toggleRegionAt(cutout, x, y)) {
    rebuildModel({ resetView: false, maskChanged: true });
    drawCutout();
  }
});
