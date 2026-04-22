const MIN_DURATION_SECONDS = 120;
const STEP_ORDER = ["intro", "prep", "numbers", "permissions", "capture", "review"];
const GUIDED_STAGES = [
  {
    key: "front",
    label: "Front view",
    title: "Start at the front",
    body: "Hold the full front bumper, grille, and both headlights in frame.",
    nextMove: "Now move clockwise toward the front-left corner.",
    cueAfter: 8
  },
  {
    key: "frontLeft",
    label: "Front-left corner",
    title: "Front-left corner",
    body: "Show the bonnet edge, left headlight, fender, and wheel together.",
    nextMove: "Continue along the left side in one slow sweep.",
    cueAfter: 12
  },
  {
    key: "left",
    label: "Left side",
    title: "Track the left profile",
    body: "Keep both left doors, mirror, and wheel line visible while walking slowly.",
    nextMove: "Arc to the rear-left corner and pause there briefly.",
    cueAfter: 15
  },
  {
    key: "rearLeft",
    label: "Rear-left corner",
    title: "Rear-left corner",
    body: "Catch the tail lamp, rear quarter panel, and bumper together.",
    nextMove: "Center the full rear next.",
    cueAfter: 12
  },
  {
    key: "rear",
    label: "Rear view",
    title: "Center the rear",
    body: "Pause for a clean rear view with the number plate and both tail lamps visible.",
    nextMove: "Continue clockwise to the rear-right corner.",
    cueAfter: 10
  },
  {
    key: "rearRight",
    label: "Rear-right corner",
    title: "Rear-right corner",
    body: "Keep the tail lamp, bumper edge, and right rear quarter in view.",
    nextMove: "Move down the right side in one steady pass.",
    cueAfter: 12
  },
  {
    key: "right",
    label: "Right side",
    title: "Track the right profile",
    body: "Show the full right side with doors, mirror, and wheel line visible.",
    nextMove: "Close the loop at the front-right corner.",
    cueAfter: 15
  },
  {
    key: "frontRight",
    label: "Front-right corner",
    title: "Close the loop",
    body: "Finish with the front-right corner and one final pass across the grille.",
    nextMove: "If all eight slices are green, stop whenever you’re satisfied.",
    cueAfter: 12
  }
];

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
  motionLevel: "steady",
  stageStartTime: null,
  currentStageIndex: 0,
  softNudgeShown: false,
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
const finishHint = $("#finishHint");
const softNudge = $("#softNudge");
const summaryDuration = $("#summaryDuration");
const summaryStatus = $("#summaryStatus");
const submitResult = $("#submitResult");
const ackToast = $("#ackToast");
const radarWheel = $("#radarWheel");

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
  $("#prepContinue").disabled = !Object.values(state.prep).every(Boolean);
  $("#numbersContinue").disabled = !Object.values(state.locator).every(Boolean);
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

function buildRadar(activeIndex = 0) {
  radarWheel.innerHTML = "";
  GUIDED_STAGES.forEach((stage, index) => {
    const segment = document.createElement("span");
    segment.className = "radar-segment";
    segment.style.transform = `rotate(${index * 45}deg)`;
    segment.setAttribute("aria-label", stage.label);

    if (state.acknowledgedStages.has(index)) {
      segment.classList.add("done");
    } else if (index === activeIndex) {
      segment.classList.add("active");
    }

    radarWheel.appendChild(segment);
  });
}

function getActiveStage() {
  return GUIDED_STAGES[state.currentStageIndex];
}

function refreshCoachmark() {
  const active = getActiveStage();
  coachmarkMeta.textContent = active.label;
  coachmarkTitle.textContent = active.title;
  coachmarkBody.textContent = active.body;
  finishHint.textContent = active.nextMove;
  buildRadar(state.currentStageIndex);
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
  const stage = getActiveStage();
  const timeInStage = state.stageStartTime ? elapsedSeconds - state.stageStartTime : 0;

  if (!isLandscape) {
    qualityPill.textContent = "Rotate to landscape";
    signalBadge.textContent = "Rotate device";
    return;
  }

  if (state.motionLevel === "fast") {
    qualityPill.textContent = "Slow down a little";
    signalBadge.textContent = "Steady sweep";
    return;
  }

  if (timeInStage > stage.cueAfter && !state.acknowledgedStages.has(state.currentStageIndex)) {
    qualityPill.textContent = "Tap Seen when this angle is clear";
    signalBadge.textContent = "Confirm angle";
    return;
  }

  if (state.acknowledgedStages.has(state.currentStageIndex)) {
    qualityPill.textContent = "Move clockwise";
    signalBadge.textContent = "Next angle";
    return;
  }

  qualityPill.textContent = "Keep the whole side visible";
  signalBadge.textContent = "Coverage tracking";
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
    warningBanner.textContent = "Camera is live. Start at the front of the car.";
    signalBadge.textContent = "Camera live";
    setPanel("capture");
    resetGuidance();
  } catch (error) {
    warningBanner.textContent = "Camera or microphone access is blocked. Please allow permissions and try again.";
    setStatus("cameraStatus", "Blocked", "status-error");
    setStatus("audioStatus", "Blocked", "status-error");
    signalBadge.textContent = "Permissions blocked";
    console.error(error);
  }
}

function resetGuidance() {
  state.currentStageIndex = 0;
  state.stageStartTime = 0;
  state.acknowledgedStages = new Set();
  refreshCoachmark();
  qualityPill.textContent = "Start at the front";
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
  state.recordingStart = Date.now();
  state.softNudgeShown = false;
  submitResult.classList.add("hidden");
  softNudge.classList.add("hidden");
  resetGuidance();

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
    updateQualityPill(elapsedSeconds);

    if (elapsedSeconds >= MIN_DURATION_SECONDS && !state.softNudgeShown) {
      softNudge.classList.remove("hidden");
      finishHint.textContent =
        state.acknowledgedStages.size >= GUIDED_STAGES.length
          ? "All slices look covered. Stop whenever you’re satisfied."
          : "Take a final pass across any slice that is not green yet.";
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
      : "Retake if any side or corner feels incomplete";
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
  resetGuidance();
  setPanel("capture");
}

function deleteCapture() {
  cleanupRecording();
  signalBadge.textContent = "Capture deleted";
}

function markCurrentStage() {
  if (!state.recordingStart) return;

  state.acknowledgedStages.add(state.currentStageIndex);
  const label = GUIDED_STAGES[state.currentStageIndex].label;
  showToast(`${label} marked`);
  emitHaptic(12);

  if (state.currentStageIndex < GUIDED_STAGES.length - 1) {
    state.currentStageIndex += 1;
    const elapsedSeconds = (Date.now() - state.recordingStart) / 1000;
    state.stageStartTime = elapsedSeconds;
    refreshCoachmark();
    updateQualityPill(elapsedSeconds);
  } else {
    refreshCoachmark();
    qualityPill.textContent = "Full loop covered";
    finishHint.textContent = "All slices are green. Take a brief final sweep and stop.";
    buildRadar(state.currentStageIndex);
  }
}

$$("[data-next]").forEach((button) => {
  button.addEventListener("click", () => setPanel(button.dataset.next));
});

$$("[data-back]").forEach((button) => {
  button.addEventListener("click", () => setPanel(button.dataset.back));
});

$$("[data-ack]").forEach((button) => {
  button.addEventListener("click", () => {
    state.prep[button.dataset.ack] = true;
    markButtonDone(button);
    updateContinueButtons();
    showToast("Acknowledged");
  });
});

$$("[data-locator]").forEach((button) => {
  button.addEventListener("click", () => {
    state.locator[button.dataset.locator] = true;
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

resetGuidance();
updateContinueButtons();
probeDevice();
