import { detectNonChromeBrowser, chromeIntentUrl } from "./browser.js";
import { ARScene } from "./arScene.js";

const $ = (id) => document.getElementById(id);
const CLEAN_SHOT_SECONDS = 5;

/**
 * Everything after "AR로 내 공간에 놓기": browser notices, the AR session,
 * move/rotate modes, capture + save/share, and the no-camera fallback.
 *
 * @param {object} opts
 * @param {import("./previewScene.js").PreviewScene} opts.preview
 * @param {() => import("three").Group | null} opts.getModel
 * @param {string} opts.filePrefix - saved photo name prefix
 * @returns {{ isArSupported: () => boolean }}
 */
export function setupArApp({ preview, getModel, filePrefix }) {
  const setupScreen = $("setup-screen");
  const arScreenEl = $("ar-screen");
  const arOverlay = $("ar-overlay");
  const arHint = $("arHint");
  const arControls = $("arControls");
  const captureBtn = $("captureBtn");
  const resetBtn = $("resetBtn");
  const exitArBtn = $("exitArBtn");
  const modeToggle = $("modeToggle");
  const goArBtn = $("goArBtn");
  const arSupportText = $("arSupportText");
  const captureSheet = $("captureSheet");
  const captureImg = $("captureImg");
  const shareShotBtn = $("shareShotBtn");
  const closeShotBtn = $("closeShotBtn");
  const arToast = $("arToast");
  const shutterFlash = $("shutterFlash");
  const shotThumb = $("shotThumb");
  const shotThumbImg = $("shotThumbImg");
  const noCapturePanel = $("noCapturePanel");

  // ---------- Browser notices ----------
  const nonChromeBrowser = detectNonChromeBrowser();
  const isSamsungInternet = nonChromeBrowser === "samsung";
  for (const a of document.querySelectorAll(".chrome-link")) {
    a.href = chromeIntentUrl();
    a.hidden = !nonChromeBrowser;
  }
  $("browserTip").hidden = !nonChromeBrowser;
  const inAppNames = { naver: "네이버 앱", kakao: "카카오톡" };
  if (inAppNames[nonChromeBrowser]) {
    $("browserTipText").innerHTML =
      `${inAppNames[nonChromeBrowser]}에서는 AR 기능(내 공간에 놓기, 사진 촬영)을 쓸 수 없어요.<br />Chrome에서 열어주세요.`;
    $("browserTipFallback").hidden = false;
  }

  let arSupported = false;
  ARScene.isSupported().then((supported) => {
    arSupported = supported;
    arSupportText.textContent = supported
      ? ""
      : "이 브라우저/기기는 WebXR AR을 지원하지 않아요. Android Chrome 최신 버전에서 열어보세요.";
  });

  // ---------- AR session ----------
  let arScene = null;
  function getArScene() {
    if (!arScene) {
      arScene = new ARScene({
        overlayEl: arOverlay,
        onPlacementChanged: (isPlaced) => {
          arHint.hidden = isPlaced;
          arControls.hidden = !isPlaced;
          modeToggle.hidden = !isPlaced;
          if (isPlaced) {
            showToast("한 손가락으로 끌면 이동, '회전'을 누르고 좌우로 밀면 돌아가요. 두 손가락을 벌리거나 오므리면 크기가 바뀌어요.", 5000);
          }
        },
        onSessionEnd: () => exitArUI(),
      });
    }
    return arScene;
  }

  goArBtn.addEventListener("click", async () => {
    const model = getModel();
    if (!model) return;
    const scene = getArScene();
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.setScalar(0.4); // ~40cm tall in the room to start
    scene.setModel(model); // moves it out of the preview scene automatically

    setupScreen.classList.remove("active");
    arScreenEl.classList.add("active");
    arHint.hidden = false;
    arControls.hidden = true;
    modeToggle.hidden = true;
    setMode("move");

    try {
      await scene.start();
    } catch (err) {
      console.error(err);
      alert("AR 세션을 시작하지 못했어요: " + (err?.message || err));
      exitArUI();
    }
  });

  function exitArUI() {
    arScreenEl.classList.remove("active");
    setupScreen.classList.add("active");
    captureSheet.hidden = true;
    shotThumb.hidden = true;
    noCapturePanel.hidden = true;
    arOverlay.classList.remove("clean");
    const model = getModel();
    if (model) {
      model.position.set(0, 0, 0);
      model.rotation.set(0, 0, 0);
      model.scale.setScalar(1);
      model.visible = true;
      preview.setModel(model); // bring it back to the turntable preview
    }
  }

  exitArBtn.addEventListener("click", async () => {
    if (arScene) await arScene.end();
  });

  function setMode(mode) {
    for (const b of modeToggle.querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.mode === mode);
    }
    if (arScene) arScene.setInteractionMode(mode);
  }
  modeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (btn) setMode(btn.dataset.mode);
  });

  resetBtn.addEventListener("click", () => {
    if (arScene) arScene.resetPlacement();
  });

  // Taps on our buttons shouldn't also count as an AR "select" (which would
  // re-place the model right after pressing ↺, for example).
  arOverlay.addEventListener("beforexrselect", (e) => {
    if (e.target.closest("#arControls, .ar-ui")) e.preventDefault();
  });

  // ---------- Capture ----------
  let lastShot = null; // { file, url }
  let toastTimer = null;

  function showToast(text, ms = 3500, { success = false } = {}) {
    arToast.textContent = text;
    arToast.classList.toggle("success", success);
    arToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (arToast.hidden = true), ms);
  }

  function restartAnimation(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow so the same animation can play again
    el.classList.add(cls);
  }

  function saveToDevice(shot) {
    const a = document.createElement("a");
    a.href = shot.url;
    a.download = shot.file.name;
    arOverlay.appendChild(a);
    a.click();
    a.remove();
  }

  captureBtn.addEventListener("click", async () => {
    if (!arScene) return;
    captureBtn.disabled = true;
    try {
      const result = await arScene.requestCapture();
      // Flash only on success (it's DOM-only, so it never lands in the image).
      if (result.ok) restartAnimation(shutterFlash, "go");
      if (!result.ok) {
        if (result.error?.message === "NO_CAMERA_ACCESS") showNoCapturePanel(result.error.code);
        else showToast("캡처에 실패했어요: " + (result.error?.message || result.error), 8000);
        return;
      }
      const blob = await pixelsToJpeg(result);
      if (lastShot) URL.revokeObjectURL(lastShot.url);
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      lastShot = {
        file: new File([blob], `${filePrefix}-${stamp}.jpg`, { type: "image/jpeg" }),
        url: URL.createObjectURL(blob),
      };
      // Still inside the tap's user-activation window, so Chrome allows the download.
      saveToDevice(lastShot);

      captureImg.src = lastShot.url;
      shotThumbImg.src = lastShot.url;
      shotThumb.hidden = false;
      restartAnimation(shotThumb, "pop");
      shareShotBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [lastShot.file] }));
      showToast("✓ 사진을 저장했어요 (갤러리 → Download 앨범)", 3000, { success: true });
    } catch (err) {
      console.error(err);
      showToast("캡처에 실패했어요: " + (err?.message || err), 6000);
    } finally {
      captureBtn.disabled = false;
    }
  });

  shotThumb.addEventListener("click", () => {
    if (lastShot) captureSheet.hidden = false;
  });

  shareShotBtn.addEventListener("click", async () => {
    if (!lastShot) return;
    try {
      await navigator.share({ files: [lastShot.file] });
    } catch (err) {
      if (err?.name !== "AbortError") showToast("공유하지 못했어요: " + (err?.message || err));
    }
  });

  closeShotBtn.addEventListener("click", () => {
    captureSheet.hidden = true;
  });

  // ---------- When the browser can't capture the camera ----------
  function showNoCapturePanel(code) {
    const version = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || "?";
    // AR sessions only run on Android, so Chrome is always a way out here,
    // unless this already is Google Chrome (then the camera permission was refused).
    const isGoogleChrome = !!navigator.userAgentData?.brands?.some((b) => b.brand === "Google Chrome");
    noCapturePanel.querySelector(".chrome-link").hidden = isGoogleChrome;
    $("noCaptureText").textContent = isGoogleChrome
      ? "카메라 권한이 허용되지 않아 AR 사진을 찍을 수 없어요. AR을 끝내고 다시 시작할 때 카메라를 허용해주세요."
      : isSamsungInternet
        ? "삼성 인터넷은 AR 사진 촬영을 지원하지 않아요. Chrome에서 열면 📸 버튼으로 바로 저장돼요."
        : "이 브라우저는 AR 사진 촬영을 지원하지 않아요. Chrome에서 열면 📸 버튼으로 바로 저장돼요.";
    const name = isGoogleChrome ? "Chrome" : isSamsungInternet ? "Samsung Internet" : "Chromium";
    $("noCaptureCode").textContent = `(코드: ${code}, ${name} ${version})`;
    $("cleanShotBtn").textContent = `버튼 숨기고 직접 캡처 (${CLEAN_SHOT_SECONDS}초)`;
    noCapturePanel.hidden = false;
  }

  $("noCaptureCloseBtn").addEventListener("click", () => {
    noCapturePanel.hidden = true;
  });

  $("cleanShotBtn").addEventListener("click", () => {
    noCapturePanel.hidden = true;
    arToast.hidden = true;
    arOverlay.classList.add("clean");
    setTimeout(() => {
      arOverlay.classList.remove("clean");
      showToast("버튼이 다시 나타났어요. 캡처한 사진은 갤러리의 스크린샷 앨범에 있어요.", 4000);
    }, CLEAN_SHOT_SECONDS * 1000);
  });

  return { isArSupported: () => arSupported };
}

function pixelsToJpeg({ pixels, width, height }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    // WebGL rows come bottom-up.
    image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 변환 실패"))), "image/jpeg", 0.92)
  );
}
