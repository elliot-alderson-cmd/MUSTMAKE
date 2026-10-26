import { createExerciseDetector } from "./exercise-detectors.mjs";

const MEDIAPIPE_VERSION = "1.1.1";
const MEDIAPIPE_MODULE =
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MEDIAPIPE_WASM =
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const POSE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const MAX_REPETITIONS = 10000;
const MAX_REVIEWED_VALUE = 150;
const INFERENCE_INTERVAL_MS = 110;
const OVERLAY_VISIBILITY_THRESHOLD = 0.15;
const CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31],
    [24, 26], [26, 28], [28, 30], [30, 32]
];

let visionModulePromise;

function loadVisionModule() {
    if (!visionModulePromise) {
        visionModulePromise = import(MEDIAPIPE_MODULE).catch(error => {
            visionModulePromise = null;
            throw new Error("Could not load the MediaPipe pose library. Check your internet connection and try again.", {
                cause: error
            });
        });
    }
    return visionModulePromise;
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function cameraErrorMessage(error) {
    if (!window.isSecureContext) {
        return "Camera access requires HTTPS or localhost. Open this page in a secure context and try again.";
    }
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
    }
    if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
        return "No camera was found. Connect a camera and try again.";
    }
    if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
        return "The camera is unavailable or being used by another app. Close other camera apps and try again.";
    }
    if (error?.name === "OverconstrainedError") {
        return "The camera could not provide a supported video mode. Try another camera.";
    }
    return "Could not start the camera. Check your browser and camera settings, then try again.";
}

async function createPoseLandmarker(delegate = "GPU") {
    const { FilesetResolver, PoseLandmarker } = await loadVisionModule();
    try {
        const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        const options = {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.35,
            minPosePresenceConfidence: 0.35,
            minTrackingConfidence: 0.35
        };
        try {
            return {
                landmarker: await PoseLandmarker.createFromOptions(fileset, options),
                delegate
            };
        } catch (initializationError) {
            if (delegate === "CPU") throw initializationError;
            console.warn("MediaPipe GPU initialization failed; retrying with CPU.", initializationError);
            try {
                return {
                    landmarker: await PoseLandmarker.createFromOptions(fileset, {
                        ...options,
                        baseOptions: { modelAssetPath: POSE_MODEL, delegate: "CPU" }
                    }),
                    delegate: "CPU"
                };
            } catch (cpuError) {
                throw new Error("Pose detection could not initialize with GPU or CPU.", {
                    cause: cpuError
                });
            }
        }
    } catch (error) {
        console.error("MediaPipe WASM or pose model initialization failed.", error);
        throw error;
    }
}

function waitForVideoFrame(video) {
    if (
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
    ) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        let timeout;
        const cleanup = () => {
            clearTimeout(timeout);
            video.removeEventListener("loadeddata", checkReady);
            video.removeEventListener("resize", checkReady);
            video.removeEventListener("error", handleError);
        };
        const checkReady = () => {
            if (
                video.readyState >= 2 &&
                video.videoWidth > 0 &&
                video.videoHeight > 0
            ) {
                cleanup();
                resolve();
            }
        };
        const handleError = () => {
            cleanup();
            reject(new Error("The camera did not provide a readable video frame."));
        };

        video.addEventListener("loadeddata", checkReady);
        video.addEventListener("resize", checkReady);
        video.addEventListener("error", handleError);
        timeout = setTimeout(() => {
            cleanup();
            reject(new Error(
                `Timed out waiting for a camera frame (readyState=${video.readyState}, ` +
                `size=${video.videoWidth}x${video.videoHeight}).`
            ));
        }, 10000);
        checkReady();
    });
}

function roundedDuration(milliseconds) {
    return Math.max(0, Math.floor(milliseconds / 1000));
}

export function mountAiMonitor(
    root,
    exercise,
    snapshot = null,
    pendingWorkout = null,
    onSignInRequired = null,
    onWorkoutSaved = null
) {
    const isPlank = exercise.slug === "plank";
    const isJumpCount = exercise.slug === "skipping-rope";
    const video = root.querySelector("#monitorVideo");
    const canvas = root.querySelector("#monitorCanvas");
    const preview = root.querySelector(".monitor-preview");
    const compositePreview = window.innerWidth <= 768 ||
        Boolean(window.matchMedia?.("(pointer: coarse)").matches);
    const placeholder = root.querySelector(".monitor-preview-placeholder");
    const status = root.querySelector("#monitorStatus");
    const cameraStatus = root.querySelector("#monitorCameraStatus");
    const feedback = root.querySelector("#monitorFeedback");
    const countOutput = root.querySelector("#monitorRepCount");
    const timeOutput = root.querySelector("#monitorSessionTime");
    const finishButton = root.querySelector("#monitorFinish");
    const summary = root.querySelector("#monitorSummary");
    const summaryExercise = root.querySelector("#monitorSummaryExercise");
    const summaryMetric = root.querySelector("#monitorSummaryMetric");
    const correction = root.querySelector("#monitorCorrection");
    const weightInput = root.querySelector("#workout-weight");
    const correctionError = root.querySelector("#monitorCorrectionError");
    const saveButton = root.querySelector("#monitorSave");
    const discardButton = root.querySelector("#monitorDiscard");
    const saveMessage = root.querySelector("#monitorSaveMessage");
    const context = canvas.getContext("2d");
    const detector = createExerciseDetector(exercise.slug);
    const listeners = new AbortController();
    let compositingAvailable = compositePreview;

    preview.classList.toggle("monitor-preview-composited", compositePreview);

    let lifecycle = "idle";
    let stream = null;
    let landmarker = null;
    let landmarkerDelegate = null;
    let animationFrame = null;
    let resizeObserver = null;
    let disposed = false;
    let frameProcessing = false;
    let lastInferenceAt = 0;
    let lastTimestamp = 0;
    let lastCompositeFrameAt = 0;
    let emptyLandmarkFrames = 0;
    let currentLandmarks = null;
    let cameraOrientationHint = "";
    let elapsedMs = Math.max(0, Number(snapshot?.elapsedMs) || 0);
    let rawCount = Math.max(0, Math.min(MAX_REPETITIONS, Number(snapshot?.rawCount) || 0));
    let saveInFlight = false;
    let cameraEnded = false;
    let sessionStarted = Boolean(snapshot?.sessionStarted || snapshot?.finished);

    if (countOutput) countOutput.textContent = String(rawCount);
    if (timeOutput) timeOutput.textContent = formatTime(roundedDuration(elapsedMs));
    correction.value = String(rawCount);
    detector.reset(isPlank ? elapsedMs : rawCount);

    function setStatus(state, message) {
        lifecycle = state;
        status.dataset.state = state;
        status.textContent = message;
        finishButton.disabled = !["ready", "running"].includes(state) &&
            !(state === "error" && sessionStarted);
        saveButton.disabled = !["finished", "saving"].includes(state) || saveInFlight;
        discardButton.disabled = state !== "finished";
        correction.disabled = state === "saving" || state === "saved";
        if (state === "finished" || state === "saving" || state === "saved") {
            summary.hidden = false;
        }
    }

    function setFeedback(message) {
        feedback.textContent = message;
    }

 function clearOverlay() {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();

    if (!bounds.width || !bounds.height) return;

    const ratio = Math.max(1, window.devicePixelRatio || 1);

    const pixelWidth = Math.max(1, Math.round(bounds.width * ratio));
    const pixelHeight = Math.max(1, Math.round(bounds.height * ratio));

    if (canvas.width !== pixelWidth) {
        canvas.width = pixelWidth;
    }

    if (canvas.height !== pixelHeight) {
        canvas.height = pixelHeight;
    }

    clearOverlay();

    context.setTransform(
        canvas.width / bounds.width,
        0,
        0,
        canvas.height / bounds.height,
        0,
        0
    );
}

function updatePreviewAspectRatio() {
    const useLandscapePreview = window.innerWidth <= 768 ||
        Boolean(window.matchMedia?.("(pointer: coarse)").matches);
    const aspectRatio = useLandscapePreview
        ? "16 / 9"
        : video.videoWidth && video.videoHeight
            ? `${video.videoWidth} / ${video.videoHeight}`
            : "4 / 3";

    preview.style.aspectRatio = aspectRatio;

    requestAnimationFrame(() => {
        if (!disposed) {
            resizeCanvas();
        }
    });
}

function drawPose(landmarks) {
    clearOverlay();

    if (
        (!landmarks?.length && !compositePreview) ||
        !video.videoWidth ||
        !video.videoHeight
    ) {
        return;
    }

    const bounds = canvas.getBoundingClientRect();

    if (
        !bounds.width ||
        !bounds.height ||
        !canvas.width ||
        !canvas.height
    ) {
        return;
    }

    // Match the video's object-fit: contain behavior.
    const scale = Math.min(
        bounds.width / video.videoWidth,
        bounds.height / video.videoHeight
    );

    const drawnWidth = video.videoWidth * scale;
    const drawnHeight = video.videoHeight * scale;

    const offsetX = (bounds.width - drawnWidth) / 2;
    const offsetY = (bounds.height - drawnHeight) / 2;

    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;

    context.save();

    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(74, 222, 128, 0.95)";
    context.fillStyle = "#f8fafc";

    if (compositingAvailable) {
        const blur = 18;
        const overscan = blur * 2;
        const backgroundScale = Math.max(
            (bounds.width + overscan * 2) / video.videoWidth,
            (bounds.height + overscan * 2) / video.videoHeight
        );
        const backgroundWidth = video.videoWidth * backgroundScale;
        const backgroundHeight = video.videoHeight * backgroundScale;

        context.filter = `blur(${blur}px)`;
        context.drawImage(
            video,
            (bounds.width - backgroundWidth) / 2,
            (bounds.height - backgroundHeight) / 2,
            backgroundWidth,
            backgroundHeight
        );
        context.filter = "none";
        context.drawImage(video, offsetX, offsetY, drawnWidth, drawnHeight);
    }

    if (!landmarks?.length) {
        context.restore();
        return;
    }

    const visibilityOf = landmark =>
        landmark?.visibility ?? landmark?.presence ?? 1;

    function point(index) {
        const landmark = landmarks[index];

        if (
            !landmark ||
            !Number.isFinite(landmark.x) ||
            !Number.isFinite(landmark.y) ||
            visibilityOf(landmark) < OVERLAY_VISIBILITY_THRESHOLD
        ) {
            return null;
        }

        return {
            x: landmark.x * drawnWidth + offsetX,
            y: landmark.y * drawnHeight + offsetY
        };
    }

    for (const [fromIndex, toIndex] of CONNECTIONS) {
        const from = point(fromIndex);
        const to = point(toIndex);

        if (!from || !to) continue;

        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
    }

    landmarks.forEach((landmark, index) => {
        if (visibilityOf(landmark) < OVERLAY_VISIBILITY_THRESHOLD) return;

        const position = point(index);

        if (!position) return;

        context.beginPath();
        context.arc(position.x, position.y, 3.5, 0, Math.PI * 2);
        context.fill();
    });

    context.restore();
}
    function updateClock() {
        if (isPlank && timeOutput) {
            timeOutput.textContent = formatTime(roundedDuration(detector.elapsedMs));
        }
    }

    function stopProcessing() {
        if (animationFrame != null) {
            cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
    }

    function releaseCamera() {
        currentLandmarks = null;
        if (stream) {
            stream.getTracks().forEach(track => {
                track.onended = null;
                track.stop();
            });
            stream = null;
        }
        video.pause();
        video.srcObject = null;
        video.hidden = true;
        placeholder.hidden = false;
        cameraStatus.textContent = "Camera off";
        clearOverlay();
    }

    function closeLandmarker() {
        if (landmarker) {
            try {
                landmarker.close();
            } catch (error) {
                console.warn("Could not close pose detector cleanly.", error);
            }
            landmarker = null;
        }
        landmarkerDelegate = null;
    }

    function endActiveInterval() {
        if (isPlank) {
            detector.pause();
            elapsedMs = detector.elapsedMs;
            updateClock();
        }
    }

    function releaseMonitoring() {
        stopProcessing();
        releaseCamera();
        closeLandmarker();
    }

    function updateCurrentPose(landmarks) {
        currentLandmarks = landmarks;
        if (!landmarks?.length) {
            renderPose(null);
            if (isPlank) {
                const result = detector.update(null, performance.now());
                elapsedMs = result.elapsedMs;
                setFeedback(result.feedback);
                updateClock();
            } else {
                detector.loseTracking();
                setFeedback("Person not detected. Move fully into the camera frame.");
            }
            return;
        }
        renderPose(landmarks);
        const result = detector.update(landmarks, performance.now());
        if (isPlank) {
            elapsedMs = result.elapsedMs;
            updateClock();
        } else {
            rawCount = result.count;
            if (countOutput) countOutput.textContent = String(rawCount);
        }
        setFeedback(result.feedback);
    }

    function renderPose(landmarks) {
        try {
            drawPose(landmarks);
        } catch (error) {
            console.error("Canvas pose preview rendering failed.", error);
            if (compositingAvailable) {
                compositingAvailable = false;
                preview.classList.remove("monitor-preview-composited");
                try {
                    drawPose(landmarks);
                } catch (overlayError) {
                    console.error("Pose overlay could not be rendered.", overlayError);
                }
            }
        }
    }

    async function retryInferenceOnCpu(error, now) {
        if (landmarkerDelegate !== "GPU") throw error;

        console.warn("MediaPipe GPU inference failed; retrying with CPU.", error);
        closeLandmarker();
        const cpu = await createPoseLandmarker("CPU");
        if (disposed || lifecycle !== "running") {
            cpu.landmarker.close();
            return null;
        }
        landmarker = cpu.landmarker;
        landmarkerDelegate = cpu.delegate;
        console.info("MediaPipe CPU inference fallback is active.");
        const timestamp = Math.max(now, lastTimestamp + 1);
        lastTimestamp = timestamp;
        return landmarker.detectForVideo(video, timestamp);
    }

    async function processFrames(now) {
        if (frameProcessing || disposed || lifecycle !== "running" || document.hidden) return;
        frameProcessing = true;
        animationFrame = null;

        try {
            const hasFrame = video.readyState >= 2 &&
                video.videoWidth > 0 &&
                video.videoHeight > 0;

            if (compositingAvailable && hasFrame && now - lastCompositeFrameAt >= 33) {
                lastCompositeFrameAt = now;
                renderPose(currentLandmarks);
            }

            if (now - lastInferenceAt >= INFERENCE_INTERVAL_MS) {
                if (!hasFrame) {
                    if (now - lastInferenceAt >= 1000) {
                        lastInferenceAt = now;
                        console.warn("Pose inference waiting for camera frame.", {
                            readyState: video.readyState,
                            videoWidth: video.videoWidth,
                            videoHeight: video.videoHeight
                        });
                    }
                } else {
                    lastInferenceAt = now;
                    let timestamp = Math.max(now, lastTimestamp + 1);
                    lastTimestamp = timestamp;
                    let result;
                    try {
                        result = landmarker.detectForVideo(video, timestamp);
                    } catch (error) {
                        result = await retryInferenceOnCpu(error, now);
                        timestamp = lastTimestamp;
                    }
                    if (result) {
                        const landmarks = result.landmarks?.[0] || null;
                        if (!landmarks?.length) {
                            emptyLandmarkFrames += 1;
                            if (emptyLandmarkFrames === 1 || emptyLandmarkFrames % 30 === 0) {
                                console.info("MediaPipe inference returned no pose landmarks.", {
                                    frameCount: emptyLandmarkFrames,
                                    delegate: landmarkerDelegate,
                                    timestamp,
                                    videoWidth: video.videoWidth,
                                    videoHeight: video.videoHeight,
                                    readyState: video.readyState
                                });
                            }
                        } else {
                            emptyLandmarkFrames = 0;
                        }
                        try {
                            updateCurrentPose(landmarks);
                        } catch (error) {
                            console.error("Pose overlay rendering failed.", error);
                        }
                    }
                }
            }
            if (isPlank) updateClock();
        } catch (error) {
            console.error("Pose inference could not continue.", {
                delegate: landmarkerDelegate,
                readyState: video.readyState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                timestamp: lastTimestamp,
                error
            });
            endActiveInterval();
            releaseMonitoring();
            const message = "Pose tracking stopped unexpectedly. Restart monitoring to try again.";
            cameraStatus.textContent = "Tracking stopped";
            setFeedback(message);
            setStatus("error", message);
        } finally {
            frameProcessing = false;
            if (!disposed && lifecycle === "running" && !document.hidden) {
                animationFrame = requestAnimationFrame(processFrames);
            }
        }
    }

    function handleVisibilityChange() {
        if (document.hidden && lifecycle === "running") {
            stopProcessing();
            clearOverlay();
            if (isPlank) {
                detector.pause();
                elapsedMs = detector.elapsedMs;
                updateClock();
            } else {
                detector.loseTracking();
            }
            setFeedback("Tracking paused while this page is hidden. Return to the page to resume.");
        } else if (!document.hidden && lifecycle === "running" && animationFrame == null) {
            setFeedback("Tracking resumed. Stand in view to re-establish your starting position.");
            animationFrame = requestAnimationFrame(processFrames);
        }
    }

    async function startMonitoring() {
        if (disposed || !["idle", "ready", "error"].includes(lifecycle)) return;
        if (!window.isSecureContext) {
            const message = cameraErrorMessage({ name: "SecurityError" });
            setStatus("error", message);
            setFeedback(message);
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            const message = "Camera access is not supported by this browser. Try a current browser over HTTPS.";
            setStatus("error", message);
            setFeedback(message);
            return;
        }
        setStatus("initializing", "Requesting camera and loading pose tracking…");
        cameraStatus.textContent = "Connecting…";
        setFeedback("Allow camera access when your browser asks. Camera video stays on this device.");

        try {
            stream = await navigator.mediaDevices.getUserMedia({
    video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 16 / 9 }
    },
    audio: false
});
            cameraEnded = false;
            if (disposed) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
                return;
            }
            const videoTrack = stream.getVideoTracks()[0];
            const zoomRange = videoTrack.getCapabilities?.().zoom;
            if (zoomRange && Number.isFinite(zoomRange.min)) {
                try {
                    await videoTrack.applyConstraints({ zoom: { exact: zoomRange.min } });
                } catch (error) {
                    console.warn("Could not set the camera to its widest zoom.", error);
                }
            }
            video.srcObject = stream;
            video.hidden = false;
            placeholder.hidden = true;
            await video.play();
            await waitForVideoFrame(video);
            updatePreviewAspectRatio();
            const videoTrackSettings = videoTrack.getSettings?.() || {};
            const portraitCapture = video.videoHeight > video.videoWidth;
            cameraOrientationHint = compositePreview && portraitCapture
                ? "This camera is delivering portrait video. Turn your phone sideways for a true landscape capture; pose tracking can continue."
                : "";
            console.info("Camera video frame is ready for pose detection.", {
                readyState: video.readyState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                trackWidth: videoTrackSettings.width,
                trackHeight: videoTrackSettings.height,
                frameRate: videoTrackSettings.frameRate,
                portraitCapture
            });
            cameraStatus.textContent = "Camera connected";
            stream.getVideoTracks().forEach(track => {
                track.onended = () => {
                    if (!["initializing", "running"].includes(lifecycle)) return;
                    cameraEnded = true;
                    endActiveInterval();
                    releaseMonitoring();
                    const message = "Camera connection ended. Start monitoring again when ready.";
                    setFeedback(message);
                    setStatus("error", message);
                };
            });
            const poseLandmarker = await createPoseLandmarker();
            landmarker = poseLandmarker.landmarker;
            landmarkerDelegate = poseLandmarker.delegate;
            console.info(`MediaPipe pose detection initialized with ${landmarkerDelegate}.`);
            if (disposed) {
                releaseMonitoring();
                return;
            }
            if (cameraEnded) throw new Error("Camera connection ended while pose tracking was loading.");
            detector.reset(isPlank ? elapsedMs : rawCount);
            lastInferenceAt = 0;
            lastTimestamp = 0;
            sessionStarted = true;
            summary.hidden = true;
            setStatus("running", "Monitoring");
            setFeedback(cameraOrientationHint ||
                "Pose tracking is ready. Stand in view to establish your starting position.");
            animationFrame = requestAnimationFrame(processFrames);
        } catch (error) {
            if (disposed) {
                releaseMonitoring();
                return;
            }
            console.error("AI monitoring initialization error:", error);
            endActiveInterval();
            releaseMonitoring();
            const message = error?.name === "SecurityError" || error?.name === "NotAllowedError" ||
                error?.name === "NotFoundError" || error?.name === "NotReadableError" ||
                error?.name === "OverconstrainedError"
                ? cameraErrorMessage(error)
                : error?.message || "AI monitoring could not start. Try again.";
            cameraStatus.textContent = "Camera off";
            setFeedback(message);
            setStatus("error", message);
        }
    }

    function finishSession() {
        if (!["ready", "running"].includes(lifecycle) &&
            !(lifecycle === "error" && sessionStarted)) return;
        endActiveInterval();
        releaseMonitoring();
        summaryExercise.textContent = exercise.name;
        const reviewValue = isPlank ? roundedDuration(elapsedMs) : rawCount;
        summaryMetric.textContent = isPlank ? formatTime(reviewValue) : String(rawCount);
        correction.value = String(reviewValue);
        correctionError.textContent = "";
        saveMessage.textContent = "";
        setFeedback(isPlank
            ? "Session finished. Review the time counted while your plank posture was aligned."
            : "Session finished. Review the detected count and make any needed correction.");
        setStatus("finished", "Session finished. Review before saving.");
        correction.focus();
    }

    function discardSession() {
        if (!["finished", "saved"].includes(lifecycle)) return;
        if (!window.confirm("Discard this session? It will not be saved.")) return;
        rawCount = 0;
        elapsedMs = 0;
        sessionStarted = false;
        detector.reset();
        if (countOutput) countOutput.textContent = "0";
        if (timeOutput) timeOutput.textContent = "00:00";
        summary.hidden = true;
        correction.value = "0";
        correctionError.textContent = "";
        saveMessage.textContent = "";
        onWorkoutSaved?.();
        setFeedback("Session discarded. Start monitoring when you are ready.");
        setStatus("idle", "Camera off");
    }

    function correctedCount() {
        const value = correction.value.trim();
        const parsed = Number(value);
        const minimum = 0;
        const maximum = MAX_REVIEWED_VALUE;
        const valid = value !== "" && Number.isSafeInteger(parsed) &&
            parsed >= minimum && parsed <= maximum;
        correctionError.textContent = valid
            ? ""
            : `Range has to be between ${minimum} to ${maximum}${isPlank ? " seconds" : isJumpCount ? " jumps" : ""}.`;
        correction.setAttribute("aria-invalid", String(!valid));
        return valid ? parsed : null;
    }

    async function saveWorkout() {
        if (lifecycle !== "finished" || saveInFlight) return;
        const reviewedValue = correctedCount();
        if (reviewedValue == null) return;
        const weight = weightInput ? Number(weightInput.value) : null;
        if (weightInput && (!Number.isFinite(weight) || weight < 0.5 ||
            weight > 1000 || !Number.isInteger(weight * 2))) {
            weightInput.setCustomValidity("Enter a weight of at least 0.5 kg in 0.5 kg increments.");
            weightInput.reportValidity();
            return;
        }
        weightInput?.setCustomValidity("");

        const payload = isPlank
            ? { exercise: exercise.name, duration: reviewedValue }
            : isJumpCount
                ? { exercise: exercise.name, amount: reviewedValue, unit: "jumps" }
                : {
                    exercise: exercise.name,
                    reps: reviewedValue,
                    sets: 1,
                    ...(weightInput ? { weight } : {})
                };
        const token = localStorage.getItem("token");
        if (!token) {
            if (!onSignInRequired?.(payload)) {
                saveMessage.textContent = "Could not preserve this workout. Please try again before signing in.";
                return;
            }
            saveMessage.textContent = "Please sign in to save this workout.";
            const link = document.createElement("a");
            link.href = "/login";
            link.textContent = " Sign in";
            saveMessage.append(link);
            return;
        }

        saveInFlight = true;
        setStatus("saving", "Saving reviewed workout…");
        saveMessage.textContent = "Saving your reviewed workout…";
        try {
            const response = await fetch(`${window.API_URL}/api/workouts`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });
            if (response.status === 401) {
                window.clearPrivateCaches?.();
                localStorage.removeItem("token");
                localStorage.removeItem("user");
                if (!onSignInRequired?.(payload)) {
                    saveMessage.textContent = "Your sign-in expired, and this workout could not be preserved. Retry before signing in.";
                    setStatus("finished", "Sign-in required to save.");
                    return;
                }
                saveMessage.textContent = "Your sign-in expired. Sign in again; this reviewed session has not been discarded.";
                const link = document.createElement("a");
                link.href = "/login";
                link.textContent = " Sign in";
                saveMessage.append(link);
                setStatus("finished", "Sign-in required to save.");
                return;
            }
            let data;
            try {
                data = await response.json();
            } catch {
                throw new Error("The server returned an unreadable response. Your session is still available to retry.");
            }
            if (!response.ok) {
                throw new Error(data?.message || `Could not save this workout (HTTP ${response.status}).`);
            }
            const responseConfirmsWorkout = isPlank
                ? Number(data?.duration) === reviewedValue
                : isJumpCount
                    ? Number(data?.amount) === reviewedValue && data?.unit === "jumps"
                : Number(data?.reps) === reviewedValue && Number(data?.sets) === 1;
            if (!data || typeof data !== "object" || data.exercise !== exercise.name ||
                !responseConfirmsWorkout ||
                (weightInput && Number(data?.weight) !== weight)) {
                throw new Error("The server response did not confirm this workout. Your reviewed session is still available.");
            }

            window.clearPrivateCaches?.();
            onWorkoutSaved?.();
            saveMessage.textContent = "Workout saved successfully. ";
            const todayLink = document.createElement("a");
            todayLink.href = "/today";
            todayLink.textContent = "View today";
            const historyLink = document.createElement("a");
            historyLink.href = "/history";
            historyLink.textContent = "Open history";
            saveMessage.append(todayLink, document.createTextNode(" or "), historyLink, document.createTextNode("."));
            setStatus("saved", "Workout saved.");
        } catch (error) {
            console.error("AI workout save error:", error);
            saveMessage.textContent = error.message || "Could not connect to the server. Your reviewed session is still available to retry.";
            setStatus("finished", "Save failed. Review is preserved; retry when ready.");
        } finally {
            saveInFlight = false;
            if (lifecycle === "finished" || lifecycle === "saved") {
                saveButton.disabled = lifecycle === "saved";
            }
        }
    }

    function saveSnapshot() {
        return {
            rawCount,
            elapsedMs: isPlank ? detector.elapsedMs : 0,
            finished: ["finished", "saving", "saved"].includes(lifecycle),
            saved: lifecycle === "saved",
            sessionStarted,
            reviewedCount: correction.value
        };
    }

    function handlePageHide() {
        dispose();
    }

    function dispose() {
        if (disposed) return null;
        endActiveInterval();
        disposed = true;
        releaseMonitoring();
        listeners.abort();
        resizeObserver?.disconnect();
        return saveSnapshot();
    }

    finishButton.addEventListener("click", finishSession, { signal: listeners.signal });
    saveButton.addEventListener("click", saveWorkout, { signal: listeners.signal });
    discardButton.addEventListener("click", discardSession, { signal: listeners.signal });
    correction.addEventListener("input", correctedCount, { signal: listeners.signal });
    document.addEventListener("visibilitychange", handleVisibilityChange, { signal: listeners.signal });
    window.addEventListener("pagehide", handlePageHide, { signal: listeners.signal });
    window.addEventListener("resize", updatePreviewAspectRatio, { signal: listeners.signal });
    window.addEventListener("orientationchange", updatePreviewAspectRatio, {
        signal: listeners.signal
    });
    video.addEventListener("loadedmetadata", updatePreviewAspectRatio, { signal: listeners.signal });
    video.addEventListener("resize", updatePreviewAspectRatio, { signal: listeners.signal });
    if ("ResizeObserver" in window) {
        resizeObserver = new ResizeObserver(resizeCanvas);
        resizeObserver.observe(canvas);
    }
    resizeCanvas();
    if (snapshot?.finished) {
        elapsedMs = Math.max(0, Number(snapshot.elapsedMs) || 0);
        rawCount = Math.max(0, Math.min(MAX_REPETITIONS, Number(snapshot.rawCount) || 0));
        if (countOutput) countOutput.textContent = String(rawCount);
        if (timeOutput) timeOutput.textContent = formatTime(roundedDuration(elapsedMs));
        summaryExercise.textContent = exercise.name;
        summaryMetric.textContent = isPlank
            ? formatTime(roundedDuration(elapsedMs))
            : String(rawCount);
        correction.value = String(snapshot.reviewedCount ?? (
            isPlank ? roundedDuration(elapsedMs) : rawCount
        ));
        summary.hidden = false;
        if (snapshot.saved) {
            saveMessage.textContent = "Workout saved successfully.";
            setStatus("saved", "Workout saved.");
        } else {
            setStatus("finished", "Session finished. Review before saving.");
        }
    } else if (pendingWorkout) {
        const reviewedValue = isPlank
            ? Number(pendingWorkout.duration)
            : isJumpCount
                ? Number(pendingWorkout.amount)
                : Number(pendingWorkout.reps);
        if (isPlank) {
            elapsedMs = reviewedValue * 1000;
            detector.reset(elapsedMs);
            if (timeOutput) timeOutput.textContent = formatTime(reviewedValue);
        } else {
            rawCount = reviewedValue;
            detector.reset(rawCount);
            if (countOutput) countOutput.textContent = String(rawCount);
        }
        summaryExercise.textContent = exercise.name;
        summaryMetric.textContent = isPlank
            ? formatTime(reviewedValue)
            : String(reviewedValue);
        correction.value = String(reviewedValue);
        if (weightInput && Number.isFinite(Number(pendingWorkout.weight))) {
            weightInput.value = String(pendingWorkout.weight);
        }
        sessionStarted = true;
        saveMessage.textContent = "You're signed in. Review your workout and save it again.";
        setStatus("finished", "Workout ready to save.");
    } else if (snapshot) {
        setStatus("ready", "Monitoring paused");
        setFeedback("Monitoring paused. Your detected count is retained; you can resume or finish the session.");
    } else {
        setStatus("idle", "Camera off");
    }

    if (!snapshot?.finished && !pendingWorkout) void startMonitoring();

    return {
        dispose,
        snapshot: saveSnapshot,
        canSwitch: () => lifecycle !== "saving"
    };
}
