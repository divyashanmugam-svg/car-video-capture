const MIN_DURATION_SECONDS = 90;
const COACHMARKS = [
  { title: "Frame the front of the car", body: "Start at the front bumper and keep the headlights visible before you move.", cueAt: 0 },
  { title: "Move to the front-left quarter", body: "Walk slowly and keep the bonnet, left fender, and wheel in one clean sweep.", cueAt: 12 },
  { title: "Capture the full left side", body: "Show both doors and the left mirrors without moving too quickly.", cueAt: 24 },
  { title: "Swing around the rear-left corner", body: "Hold steady so the rear quarter panel and tail lamp are visible together.", cueAt: 36 },
  { title: "Hold the full rear", body: "Keep the number plate and both tail lamps centered for a beat.", cueAt: 48 },
  { title: "Track along the right side", body: "Move past the rear-right quarter and show the full side profile cleanly.", cueAt: 60 },
  { title: "Complete the front-right arc", body: "Show the bumper, grille, and right headlight while closing the loop.", cueAt: 72 },
  { title: "Final safety pass", body: "Take one slow extra pass if you need to strengthen the coverage before stopping.", cueAt: 84 }
];

const state = {
  panel: "intro",
  stream: null,
  recorder: null,
  chunks: [],
  recordingStart: null,
  timerId: null,
  softNudgeShown: false,
  recordedBlob: null,
  videoUrl: null,
  torchOn: false,
  geo: null,
  metadata: null,
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
const journeyProgress = $("#journeyProgress");
const progressLabel = $("#progressLabel");
const signalBadge = $("#signalBadge");
const warningBanner = $("#warningBanner");
const cameraPreview = $("#cameraPreview");
const reviewVideo = $("#reviewVideo");
const timerPill = $("#timerPill");
const torchPill = $("#torchPill");
const riskPill = $("#riskPill");
const softNudge = $("#softNudge");
const coachmarkTitle = $("#coachmarkTitle");
const coachmarkBody = $("#coachmarkBody");
const coachmarkIndex = $("#coachmarkIndex");
const orientationText = $("#orientationText");
const geoText = $("#geoText");
const summaryDuration = $("#summaryDuration");
const summaryTimestamp = $("#summaryTimestamp");
const summaryLocation = $("#summaryLocation");
const summaryDevice = $("#summaryDevice");
const metadataDump = $("#metadataDump");
const submitResult = $("#submitResult");

function setPanel(panelName) {
  state.panel = panelName;
  panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === panelName));
  const panelOrder = ["intro", "permissions", "capture", "review"];
  const currentIndex = panelOrder.indexOf(panelName);
  journeyProgress.style.width = `${((currentIndex + 1) / panelOrder.length) * 100}%`;
  progressLabel.textContent = `Step ${currentIndex + 1} of ${panelOrder.length}`;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function setStatus(id, label, tone = "status-ok") {
  const card = document.getElementById(id);
  const labelNode = card.querySelector("span");
  labelNode.textContent = label;
  labelNode.className = tone;
}

function buildCompass(activeIndex = 0) {
  const compass = $("#compassStrip");
  compass.innerHTML = "";
  COACHMARKS.forEach((_, index) => {
    const segment = document.createElement("span");
    if (index <= activeIndex) segment.classList.add("active");
    compass.appendChild(segment);
  });
}

function emitHaptic(pattern = 25) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function currentCoachmark(seconds) {
  let active = COACHMARKS[0];
  let index = 0;
  for (let i = 0; i < COACHMARKS.length; i += 1) {
    if (seconds >= COACHMARKS[i].cueAt) {
      active = COACHMARKS[i];
      index = i;
    }
  }
  return { active, index };
}

function updateOrientationState() {
  const isLandscape = window.matchMedia("(orientation: landscape)").matches;
  orientationText.textContent = isLandscape ? "Landscape" : "Rotate to landscape";
  setStatus("orientationStatus", isLandscape ? "Good to go" : "Rotate recommended", isLandscape ? "status-ok" : "status-warn");
  if (!isLandscape && state.recorder && state.recorder.state === "recording") {
    state.integrity.orientationWarnings += 1;
    signalBadge.textContent = "Rotate device";
  }
}

function updateRiskPill() {
  const score =
    state.integrity.visibilityChanges +
    state.integrity.orientationWarnings +
    state.integrity.focusLossCount +
    state.integrity.networkOffline;

  if (score === 0) {
    riskPill.textContent = "Session clean";
    signalBadge.textContent = "Recording healthy";
    return;
  }

  if (score < 3) {
    riskPill.textContent = "Minor warnings";
    signalBadge.textContent = "Watch guidance";
    return;
  }

  riskPill.textContent = "Review integrity flags";
  signalBadge.textContent = "Attention needed";
}

async function getLocation() {
  if (!navigator.geolocation) {
    geoText.textContent = "Unavailable";
    setStatus("locationStatus", "Not supported", "status-warn");
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const payload = {
          latitude: Number(position.coords.latitude.toFixed(6)),
          longitude: Number(position.coords.longitude.toFixed(6)),
          accuracyMeters: Math.round(position.coords.accuracy)
        };
        state.geo = payload;
        geoText.textContent = `${payload.latitude}, ${payload.longitude}`;
        setStatus("locationStatus", "Captured", "status-ok");
        resolve(payload);
      },
      () => {
        geoText.textContent = "Permission denied";
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
  warningBanner.textContent = "Rear camera, microphone, and location will be used when you start recording.";
}

async function startCamera() {
  try {
    warningBanner.textContent = "Requesting camera and microphone access...";
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
    setStatus("cameraStatus", "Rear camera active", "status-ok");
    setStatus("audioStatus", "Microphone active", "status-ok");
    warningBanner.textContent = "Camera is live. Hold your phone horizontally and start when ready.";
    signalBadge.textContent = "Camera live";
    setPanel("capture");
  } catch (error) {
    warningBanner.textContent = "We could not access the rear camera and microphone. Please check browser permissions.";
    setStatus("cameraStatus", "Permission blocked", "status-error");
    setStatus("audioStatus", "Permission blocked", "status-error");
    signalBadge.textContent = "Permissions blocked";
    console.error(error);
  }
}

async function toggleTorch() {
  if (!state.stream) return;
  const [videoTrack] = state.stream.getVideoTracks();
  const capabilities = videoTrack?.getCapabilities?.() || {};
  if (!capabilities.torch) {
    torchPill.textContent = "Torch unsupported";
    warningBanner.textContent = "Torch is not available on this device/browser combination.";
    return;
  }
  try {
    state.torchOn = !state.torchOn;
    await videoTrack.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    torchPill.textContent = state.torchOn ? "Torch on" : "Torch off";
    emitHaptic(15);
  } catch (error) {
    torchPill.textContent = "Torch failed";
    console.error(error);
  }
}

function startRecording() {
  if (!state.stream) return;
  state.chunks = [];
  state.recordingStart = Date.now();
  state.softNudgeShown = false;
  submitResult.classList.add("hidden");
  softNudge.classList.add("hidden");

  const options = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ].find((mime) => MediaRecorder.isTypeSupported(mime));

  state.recorder = new MediaRecorder(state.stream, options ? { mimeType: options } : undefined);
  state.recorder.ondataavailable = (event) => {
    if (event.data.size > 0) state.chunks.push(event.data);
  };
  state.recorder.onstop = finalizeRecording;
  state.recorder.start(1000);

  $("#recordButton").disabled = true;
  $("#stopButton").disabled = false;
  signalBadge.textContent = "Recording";
  emitHaptic([40, 60, 40]);

  state.timerId = window.setInterval(() => {
    const elapsed = (Date.now() - state.recordingStart) / 1000;
    timerPill.textContent = formatDuration(elapsed);
    const { active, index } = currentCoachmark(elapsed);
    coachmarkTitle.textContent = active.title;
    coachmarkBody.textContent = active.body;
    coachmarkIndex.textContent = `${index + 1} / ${COACHMARKS.length} checkpoints`;
    buildCompass(index);

    if (Math.floor(elapsed) === active.cueAt) emitHaptic(30);

    if (elapsed >= MIN_DURATION_SECONDS && !state.softNudgeShown) {
      softNudge.classList.remove("hidden");
      state.softNudgeShown = true;
      emitHaptic([25, 40, 25]);
    }

    updateRiskPill();
  }, 500);
}

function stopRecording() {
  if (state.recorder && state.recorder.state === "recording") {
    state.recorder.stop();
    window.clearInterval(state.timerId);
    $("#recordButton").disabled = false;
    $("#stopButton").disabled = true;
  }
}

function buildMetadata(durationSeconds) {
  return {
    capturedAt: new Date().toISOString(),
    durationSeconds: Number(durationSeconds.toFixed(1)),
    recommendedMinimumSeconds: MIN_DURATION_SECONDS,
    location: state.geo,
    device: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform || "unknown",
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      pixelRatio: window.devicePixelRatio
    },
    sessionIntegrity: {
      ...state.integrity,
      orientationAtReview: window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait",
      online: navigator.onLine
    }
  };
}

function finalizeRecording() {
  const durationSeconds = state.recordingStart ? (Date.now() - state.recordingStart) / 1000 : 0;
  state.recordedBlob = new Blob(state.chunks, { type: state.recorder.mimeType || "video/webm" });
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(state.recordedBlob);
  state.metadata = buildMetadata(durationSeconds);

  reviewVideo.src = state.videoUrl;
  summaryDuration.textContent = `${Math.round(durationSeconds)} seconds`;
  summaryTimestamp.textContent = new Date(state.metadata.capturedAt).toLocaleString();
  summaryLocation.textContent = state.geo ? `${state.geo.latitude}, ${state.geo.longitude}` : "Unavailable";
  summaryDevice.textContent = `${navigator.platform || "Unknown"} / ${navigator.language}`;
  metadataDump.textContent = JSON.stringify(state.metadata, null, 2);
  setPanel("review");

  if (durationSeconds < MIN_DURATION_SECONDS) {
    signalBadge.textContent = "Below recommended duration";
  } else {
    signalBadge.textContent = "Ready for review";
  }
}

function cleanupRecording() {
  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
  }
  state.recordedBlob = null;
  state.metadata = null;
  reviewVideo.removeAttribute("src");
  metadataDump.textContent = "";
  summaryDuration.textContent = "0s";
  summaryTimestamp.textContent = "-";
  summaryLocation.textContent = "-";
  summaryDevice.textContent = "-";
  submitResult.classList.add("hidden");
}

async function submitMockedUpload() {
  if (!state.recordedBlob || !state.metadata) return;
  const submitButton = $("#submitButton");
  submitButton.disabled = true;
  submitButton.textContent = "Submitting...";

  const payload = {
    fileName: `car-walkaround-${Date.now()}.webm`,
    bytes: state.recordedBlob.size,
    metadata: state.metadata
  };

  await new Promise((resolve) => window.setTimeout(resolve, 1600));
  console.info("Mocked upload payload", payload);
  submitResult.classList.remove("hidden");
  signalBadge.textContent = "Mock submitted";
  submitButton.disabled = false;
  submitButton.textContent = "Submit mocked upload";
}

function resetToCapture() {
  cleanupRecording();
  setPanel("capture");
}

function deleteCapture() {
  cleanupRecording();
  signalBadge.textContent = "Capture deleted";
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) state.integrity.visibilityChanges += 1;
  updateRiskPill();
});

window.addEventListener("blur", () => {
  state.integrity.focusLossCount += 1;
  updateRiskPill();
});

window.addEventListener("offline", () => {
  state.integrity.networkOffline += 1;
  updateRiskPill();
});

window.addEventListener("orientationchange", updateOrientationState);
window.addEventListener("resize", updateOrientationState);

document.querySelector("[data-next='permissions']").addEventListener("click", () => setPanel("permissions"));
$("#probeButton").addEventListener("click", probeDevice);
$("#startCameraButton").addEventListener("click", startCamera);
$("#torchButton").addEventListener("click", toggleTorch);
$("#recordButton").addEventListener("click", startRecording);
$("#stopButton").addEventListener("click", stopRecording);
$("#retakeButton").addEventListener("click", resetToCapture);
$("#deleteButton").addEventListener("click", deleteCapture);
$("#submitButton").addEventListener("click", submitMockedUpload);

buildCompass(0);
updateOrientationState();
probeDevice();
