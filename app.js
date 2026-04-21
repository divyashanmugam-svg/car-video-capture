const MIN_DURATION_SECONDS = 120;
const STAGE_DURATION_SECONDS = 15;
const GUIDED_STAGES = [
  { title: "Front view", body: "Keep the full front bumper and both headlights in frame." },
  { title: "Front-left corner", body: "Angle slightly and show the bonnet, wheel, and left fender together." },
  { title: "Left side", body: "Walk slowly so the full left profile stays visible." },
  { title: "Rear-left corner", body: "Pause briefly to show the tail lamp and rear quarter clearly." },
  { title: "Rear view", body: "Center the number plate and rear bumper for a steady beat." },
  { title: "Rear-right corner", body: "Turn slowly and keep the right rear quarter fully visible." },
  { title: "Right side", body: "Capture the complete right profile before closing the loop." },
  { title: "Front-right close", body: "Finish with a final steady pass across the grille and front-right corner." }
];

const STEP_ORDER = ["intro", "prep", "numbers", "permissions", "capture", "review"];

const state = {
  panel: "intro",
  prep: {
    space: false,
    landscape: false,
    documents: false
  },
  locator: {
    engine: false,
    chassis: false
  },
  stream: null,
  recorder: null,
  chunks: [],
  recordingStart: null,
  timerId: null,
  recordedBlob: null,
  videoUrl: null,
  torchOn: false,
  geo: null,
  metadata: null,
  softNudgeShown: false,
  motionLevel: "steady",
  acknowledgedStages: new Set(),
  integrity: {
    visibilityChanges: 0,
    orientationWarnings: 0,
    focusLossCount: 0,
    networkOffline: 0
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const panels = $$("[data-panel]");
const stepChips = $$("#stepper .step-chip");
const journeyProgress = $("#journeyProgress");
const progressLabel = $("#progressLabel");
const signalBadge = $("#signalBadge");
const warningBanner = $("#warningBanner");
const cameraPreview = $("#cameraPreview");
const reviewVideo = $("#reviewVideo");
const coachmarkMeta = $("#coachmarkMeta");
const coachmarkTitle = $("#coachmarkTitle");
const coachmarkBody = $("#coachmarkBody");
const timerPill = $("#timerPill");
const qualityPill = $("#qualityPill");
const softNudge = $("#softNudge");
const finishHint = $("#finishHint");
const summaryDuration = $("#summaryDuration");
const summaryStatus = $("#summaryStatus");
const submitResult = $("#submitResult");
const ackToast = $("#ackToast");

function setPanel(panelName) {
  state.panel = panelName;
  panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === panelName));

  const progressIndex = Math.max(STEP_ORDER.indexOf(panelName), 0);
  stepChips.forEach((chip, index) => chip.classList.toggle("active", index === progressIndex));
  journeyProgress.style.width = `${((progressIndex + 1) / STEP_ORDER.length) * 100}%`;
  progressLabel.textContent = `Step ${progressIndex + 1} of ${STEP_ORDER.length}`;
}

function setStatus(id, label, tone = "status-ok") {
  const card = document.getElementById(id);
  const labelNode = card.querySelector("span");
  labelNode.textContent = label;
  labelNode.className = tone;
}

function emitHaptic(pattern = 20) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatMinutes(seconds) {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function updateContinueButtons() {
  const prepReady = Object.values(state.prep).every(Boolean);
  const numbersReady = Object.values(state.locator).every(Boolean);
  $("#prepContinue").disabled = !prepReady;
  $("#numbersContinue").disabled = !numbersReady;
}

function markButtonDone(button) {
  button.classList.add("done");
  const strong = button.querySelector("strong");
  if (strong) strong.textContent = "Done";
}

function showToast(message) {
  ackToast.textContent = message;
  ackToast.classList.remove("hidden");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => ackToast.classList.add("hidden"), 1200);
}

function buildProgressDots(activeIndex = 0) {
  const strip = $("#compassStrip");
  strip.innerHTML = "";

  GUIDED_STAGES.forEach((stage, index) => {
    const dot = document.createElement("span");
    if (state.acknowledgedStages.has(index)) dot.classList.add("done");
    if (!state.acknowledgedStages.has(index) && index === activeIndex) dot.classList.add("active");
    dot.setAttribute("aria-label", stage.title);
    strip.appendChild(dot);
  });
}

function getActiveStageIndex(elapsedSeconds) {
  return Math.min(GUIDED_STAGES.length - 1, Math.floor(elapsedSeconds / STAGE_DURATION_SECONDS));
}

function refreshCoachmark(elapsedSeconds = 0) {
  const activeIndex = getActiveStageIndex(elapsedSeconds);
  const stage = GUIDED_STAGES[activeIndex];
  coachmarkMeta.textContent = `Checkpoint ${activeIndex + 1} of ${GUIDED_STAGES.length}`;
  coachmarkTitle.textContent = stage.title;
  coachmarkBody.textContent = stage.body;
  buildProgressDots(activeIndex);
}

function updateOrientationState() {
  const isLandscape = window.matchMedia("(orientation: landscape)").matches;
  setStatus("orientationStatus", isLandscape ? "Ready" : "Rotate to landscape", isLandscape ? "status-ok" : "status-warn");

  if (!isLandscape && state.recorder?.state === "recording") {
    state.integrity.orientationWarnings += 1;
  }
}

function updateQualityPill(elapsedSeconds = 0) {
  const isLandscape = window.matchMedia("(orientation: landscape)").matches;
  const activeIndex = getActiveStageIndex(elapsedSeconds);
  const stageAcknowledged = state.acknowledgedStages.has(activeIndex);

  if (!isLandscape) {
    qualityPill.textContent = "Rotate to landscape";
    signalBadge.textContent = "Rotate device";
    return;
  }

  if (state.motionLevel === "fast") {
    qualityPill.textContent = "Move a little slower";
    signalBadge.textContent = "Slow and steady";
    return;
  }

  if (!stageAcknowledged && elapsedSeconds > activeIndex * STAGE_DURATION_SECONDS + 7) {
    qualityPill.textContent = "Mark this angle once clear";
    signalBadge.textContent = "Confirm current angle";
    return;
  }

  qualityPill.textContent = "Hold steady";
  signalBadge.textContent = "Guided capture";
}

function handleMotion(event) {
  const source = event.accelerationIncludingGravity || event.acceleration;
  if (!source) return;
  const magnitude = Math.abs(source.x || 0) + Math.abs(source.y || 0) + Math.abs(source.z || 0);
  state.motionLevel = magnitude > 24 ? "fast" : "steady";
}

async function getLocation() {
  if (!navigator.geolocation) {
    setStatus("locationStatus", "Unavailable", "status-warn");
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.geo = {
          latitude: Number(position.coords.latitude.toFixed(6)),
          longitude: Number(position.coords.longitude.toFixed(6))
        };
        setStatus("locationStatus", "Ready", "status-ok");
        resolve(state.geo);
      },
      () => {
        setStatus("locationStatus", "Skipped", "status-warn");
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

async function probeDevice() {
  updateOrientationState();
  setStatus("cameraStatus", "Ready to request", "status-warn");
  setStatus("audioStatus", "Ready to request", "status-warn");
  await getLocation();
  warningBanner.textContent = "Camera access will start the inspection view.";
}

async function startCamera() {
  try {
    warningBanner.textContent = "Requesting camera access...";
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    cameraPreview.srcObject = state.stream;
    await cameraPreview.play();
    await getLocation();
    setStatus("cameraStatus", "Active", "status-ok");
    setStatus("audioStatus", "Active", "status-ok");
    warningBanner.textContent = "Camera is live. Start when you’re ready.";
    signalBadge.textContent = "Camera live";
    setPanel("capture");
    refreshCoachmark(0);
  } catch (error) {
    warningBanner.textContent = "Camera or microphone access is blocked. Please allow permissions and try again.";
    setStatus("cameraStatus", "Blocked", "status-error");
    setStatus("audioStatus", "Blocked", "status-error");
    signalBadge.textContent = "Permissions blocked";
    console.error(error);
  }
}

async function toggleTorch() {
  if (!state.stream) return;
  const [videoTrack] = state.stream.getVideoTracks();
  const capabilities = videoTrack?.getCapabilities?.() || {};
  if (!capabilities.torch) {
    qualityPill.textContent = "Torch unavailable";
    return;
  }

  try {
    state.torchOn = !state.torchOn;
    await videoTrack.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    qualityPill.textContent = state.torchOn ? "Torch on" : "Torch off";
    emitHaptic(14);
  } catch (error) {
    qualityPill.textContent = "Torch unavailable";
    console.error(error);
  }
}

function buildMetadata(durationSeconds) {
  return {
    capturedAt: new Date().toISOString(),
    durationSeconds: Number(durationSeconds.toFixed(1)),
    recommendedMinimumSeconds: MIN_DURATION_SECONDS,
    location: state.geo,
    acknowledgedStages: Array.from(state.acknowledgedStages),
    device: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform || "unknown"
    },
    sessionIntegrity: {
      ...state.integrity,
      online: navigator.onLine
    }
  };
}

function startRecording() {
  if (!state.stream) return;

  state.chunks = [];
  state.acknowledgedStages = new Set();
  state.recordingStart = Date.now();
  state.softNudgeShown = false;
  submitResult.classList.add("hidden");
  softNudge.classList.add("hidden");
  finishHint.textContent = "We’ll nudge you when the full loop looks complete";

  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((value) =>
    MediaRecorder.isTypeSupported(value)
  );

  state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder.ondataavailable = (event) => {
    if (event.data.size > 0) state.chunks.push(event.data);
  };
  state.recorder.onstop = finalizeRecording;
  state.recorder.start(1000);

  $("#recordButton").disabled = true;
  $("#stopButton").disabled = false;
  emitHaptic([30, 40, 30]);

  state.timerId = window.setInterval(() => {
    const elapsedSeconds = (Date.now() - state.recordingStart) / 1000;
    timerPill.textContent = formatDuration(elapsedSeconds);
    refreshCoachmark(elapsedSeconds);
    updateQualityPill(elapsedSeconds);

    const allSeen = state.acknowledgedStages.size >= GUIDED_STAGES.length;
    if (elapsedSeconds >= MIN_DURATION_SECONDS && !state.softNudgeShown) {
      softNudge.classList.remove("hidden");
      finishHint.textContent = allSeen ? "Full loop acknowledged" : "Take a final pass across any side you haven’t marked";
      state.softNudgeShown = true;
      emitHaptic([20, 30, 20]);
    }
  }, 500);
}

function stopRecording() {
  if (!state.recorder || state.recorder.state !== "recording") return;
  state.recorder.stop();
  window.clearInterval(state.timerId);
  $("#recordButton").disabled = false;
  $("#stopButton").disabled = true;
}

function finalizeRecording() {
  const durationSeconds = state.recordingStart ? (Date.now() - state.recordingStart) / 1000 : 0;
  state.recordedBlob = new Blob(state.chunks, { type: state.recorder?.mimeType || "video/webm" });
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(state.recordedBlob);
  state.metadata = buildMetadata(durationSeconds);

  reviewVideo.src = state.videoUrl;
  summaryDuration.textContent = formatMinutes(durationSeconds);
  summaryStatus.textContent =
    durationSeconds >= MIN_DURATION_SECONDS && state.acknowledgedStages.size >= GUIDED_STAGES.length
      ? "Coverage looks complete"
      : "Consider a retake if any side is missing";
  signalBadge.textContent = "Review ready";
  setPanel("review");
}

function cleanupRecording() {
  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
  }

  state.recordedBlob = null;
  state.metadata = null;
  reviewVideo.removeAttribute("src");
  summaryDuration.textContent = "0m";
  summaryStatus.textContent = "Ready to submit";
  submitResult.classList.add("hidden");
}

async function submitMockedUpload() {
  if (!state.recordedBlob || !state.metadata) return;

  const button = $("#submitButton");
  button.disabled = true;
  button.textContent = "Submitting...";

  await new Promise((resolve) => window.setTimeout(resolve, 1200));
  console.info("Mocked upload payload", {
    fileName: `car-walkaround-${Date.now()}.webm`,
    bytes: state.recordedBlob.size,
    metadata: state.metadata
  });

  submitResult.classList.remove("hidden");
  button.disabled = false;
  button.textContent = "Submit mocked upload";
  signalBadge.textContent = "Submitted";
}

function resetToCapture() {
  cleanupRecording();
  refreshCoachmark(0);
  setPanel("capture");
}

function deleteCapture() {
  cleanupRecording();
  signalBadge.textContent = "Capture deleted";
}

function markCurrentStage() {
  if (!state.recordingStart) return;
  const elapsedSeconds = (Date.now() - state.recordingStart) / 1000;
  const activeIndex = getActiveStageIndex(elapsedSeconds);
  state.acknowledgedStages.add(activeIndex);
  buildProgressDots(activeIndex);
  updateQualityPill(elapsedSeconds);
  showToast(`${GUIDED_STAGES[activeIndex].title} marked`);
  emitHaptic(12);
}

$$("[data-next]").forEach((button) => {
  button.addEventListener("click", () => setPanel(button.dataset.next));
});

$$("[data-back]").forEach((button) => {
  button.addEventListener("click", () => setPanel(button.dataset.back));
});

$$("[data-ack]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.ack;
    state.prep[key] = true;
    markButtonDone(button);
    updateContinueButtons();
    showToast("Acknowledged");
  });
});

$$("[data-locator]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.locator;
    state.locator[key] = true;
    markButtonDone(button);
    updateContinueButtons();
    showToast("Marked done");
  });
});

$("#prepContinue").addEventListener("click", () => setPanel("numbers"));
$("#numbersContinue").addEventListener("click", () => setPanel("permissions"));
$("#probeButton").addEventListener("click", probeDevice);
$("#startCameraButton").addEventListener("click", startCamera);
$("#torchButton").addEventListener("click", toggleTorch);
$("#recordButton").addEventListener("click", startRecording);
$("#stopButton").addEventListener("click", stopRecording);
$("#submitButton").addEventListener("click", submitMockedUpload);
$("#retakeButton").addEventListener("click", resetToCapture);
$("#deleteButton").addEventListener("click", deleteCapture);
$("#ackStageButton").addEventListener("click", markCurrentStage);

window.addEventListener("devicemotion", handleMotion);
window.addEventListener("orientationchange", updateOrientationState);
window.addEventListener("resize", updateOrientationState);
window.addEventListener("blur", () => {
  state.integrity.focusLossCount += 1;
});
window.addEventListener("offline", () => {
  state.integrity.networkOffline += 1;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) state.integrity.visibilityChanges += 1;
});

refreshCoachmark(0);
buildProgressDots(0);
updateContinueButtons();
probeDevice();
