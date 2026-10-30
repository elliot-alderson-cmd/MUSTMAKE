const VISIBILITY_THRESHOLD = 0.4;
const SMOOTHING_ALPHA = 0.5;
const FAST_MOVEMENT_DELTA = 25;
const FAST_MOVEMENT_ALPHA = 0.9;
const MIN_SEGMENT_LENGTH = 0.015;

const LANDMARKS = {
    left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
    right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 }
};

export const SQUAT_THRESHOLDS = Object.freeze({
    visibility: VISIBILITY_THRESHOLD,
    standing: 155,
    descending: 145,
    bottom: 105,
    ascending: 125,
    settleMs: 0,
    establishMs: 250,
    returnMs: 0
});

export const PUSH_UP_THRESHOLDS = Object.freeze({
    visibility: VISIBILITY_THRESHOLD,
    starting: 140,
    lowering: 135,
    bottom: 130,
    returning: 135,
    settleMs: 0,
    establishMs: 120,
    returnMs: 0
});

export const PLANK_THRESHOLDS = Object.freeze({
    visibility: 0.45,
    maxBodyLineAngle: 90,
    maxHipDeviation: 0.18,
    minBodyLength: 0.2,
    minSupportArmAngle: 55,
    maxFrameGapMs: 180
});

export const EXERCISE_THRESHOLDS = Object.freeze({
    "pull-ups": {
        visibility: VISIBILITY_THRESHOLD,
        start: 145,
        active: 135,
        bottom: 100,
        return: 135,
        settleMs: 0,
        establishMs: 160,
        returnMs: 0,
        name: "pull-up"
    },
    "biceps-curls": {
        visibility: 0.35,
        start: 135,
        active: 125,
        bottom: 105,
        return: 120,
        settleMs: 0,
        establishMs: 100,
        returnMs: 0,
        name: "biceps curl"
    },
    "triceps-extension": {
        visibility: 0.35,
        start: 80,
        active: 95,
        bottom: 135,
        return: 115,
        settleMs: 0,
        establishMs: 100,
        returnMs: 0,
        name: "triceps extension"
    },
    "shoulder-press": {
        visibility: 0.35,
        start: 105,
        active: 115,
        bottom: 140,
        return: 120,
        settleMs: 0,
        establishMs: 100,
        returnMs: 0,
        name: "shoulder press"
    },
    "lateral-raises": {
        visibility: VISIBILITY_THRESHOLD,
        start: 35,
        active: 50,
        bottom: 80,
        return: 55,
        settleMs: 0,
        establishMs: 160,
        returnMs: 0,
        name: "lateral raise"
    }
});

function visible(landmark, threshold) {
    return Boolean(landmark) &&
        Number.isFinite(landmark.x) &&
        Number.isFinite(landmark.y) &&
        Number.isFinite(landmark.visibility) &&
        landmark.visibility >= threshold;
}

function angleAt(a, vertex, c) {
    const firstX = a.x - vertex.x;
    const firstY = a.y - vertex.y;
    const secondX = c.x - vertex.x;
    const secondY = c.y - vertex.y;
    const firstLength = Math.hypot(firstX, firstY);
    const secondLength = Math.hypot(secondX, secondY);
    if (firstLength < MIN_SEGMENT_LENGTH || secondLength < MIN_SEGMENT_LENGTH) return null;
    const cosine = Math.max(-1, Math.min(1,
        (firstX * secondX + firstY * secondY) / (firstLength * secondLength)
    ));
    return Math.acos(cosine) * 180 / Math.PI;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function smoothedAngle(previous, current) {
    if (previous == null) return current;
    const alpha = Math.abs(current - previous) >= FAST_MOVEMENT_DELTA
        ? FAST_MOVEMENT_ALPHA
        : SMOOTHING_ALPHA;
    return previous * (1 - alpha) + current * alpha;
}

class RepDetector {
    constructor(thresholds, initialLabel, lostTrackingLabel = "Can't see u.") {
        this.thresholds = thresholds;
        this.initialLabel = initialLabel;
        this.lostTrackingLabel = lostTrackingLabel;
        this.reset();
    }

    reset(count = 0) {
        this.count = count;
        this.resetMovement();
    }

    resetMovement() {
        this.state = "unknown";
        this.filteredAngle = null;
        this.pendingState = null;
        this.pendingSince = 0;
        this.feedback = this.initialLabel;
    }

    loseTracking() {
        this.state = "unknown";
        this.filteredAngle = null;
        this.pendingState = null;
        this.feedback = this.lostTrackingLabel;
    }

    holdTransition(nextState, now, duration, onTransition) {
        if (duration <= 0) {
            this.pendingState = null;
            onTransition();
            return true;
        }
        if (this.pendingState !== nextState) {
            this.pendingState = nextState;
            this.pendingSince = now;
            return false;
        }
        if (now - this.pendingSince < duration) return false;
        this.pendingState = null;
        onTransition();
        return true;
    }

    clearPending() {
        this.pendingState = null;
    }

    result(angle) {
        return {
            count: this.count,
            state: this.state,
            angle,
            feedback: this.feedback
        };
    }
}

export class SquatDetector extends RepDetector {
    constructor(thresholds = SQUAT_THRESHOLDS) {
        super(thresholds, "Stand tall.", "Can't see legs.");
    }

    update(landmarks, now = performance.now()) {
        const angles = [];
        for (const side of Object.values(LANDMARKS)) {
            const hip = landmarks?.[side.hip];
            const knee = landmarks?.[side.knee];
            const ankle = landmarks?.[side.ankle];
            if (![hip, knee, ankle].every(point => visible(point, this.thresholds.visibility))) continue;
            const angle = angleAt(hip, knee, ankle);
            if (angle != null) angles.push(angle);
        }
        if (!angles.length) {
            this.loseTracking();
            return this.result(null);
        }

        const angle = this.filteredAngle = smoothedAngle(this.filteredAngle, average(angles));
        const t = this.thresholds;

        if (this.state === "unknown") {
            this.feedback = "Stand tall.";
            if (angle >= t.standing) {
                this.holdTransition("standing", now, t.establishMs, () => {
                    this.state = "standing";
                    this.feedback = "Ready. Squat.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "standing") {
            this.feedback = "Squat down.";
            if (angle <= t.bottom) {
                this.pendingState = null;
                this.state = "bottom";
                this.feedback = "Stand up.";
            } else if (angle <= t.descending) {
                this.holdTransition("descending", now, t.settleMs, () => {
                    this.state = "descending";
                    this.feedback = "Keep lowering.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "descending") {
            this.feedback = "Keep lowering.";
            if (angle <= t.bottom) {
                this.holdTransition("bottom", now, t.settleMs, () => {
                    this.state = "bottom";
                    this.feedback = "Stand up.";
                });
            } else if (angle >= t.standing) {
                this.holdTransition("standing", now, t.settleMs, () => {
                    this.state = "standing";
                    this.feedback = "Go lower.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "bottom") {
            this.feedback = "Stand up.";
            if (angle >= t.standing) {
                this.pendingState = null;
                this.count += 1;
                this.state = "standing";
                this.feedback = "Nice rep.";
            } else if (angle >= t.ascending) {
                this.holdTransition("ascending", now, t.settleMs, () => {
                    this.state = "ascending";
                    this.feedback = "Push up.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "ascending") {
            this.feedback = "Push up.";
            if (angle >= t.standing) {
                this.holdTransition("standing", now, t.returnMs, () => {
                    this.count += 1;
                    this.state = "standing";
                    this.feedback = "Nice rep.";
                });
            } else if (angle <= t.bottom) {
                this.holdTransition("bottom", now, t.settleMs, () => {
                    this.state = "bottom";
                    this.feedback = "Stand up.";
                });
            } else {
                this.clearPending();
            }
        }
        return this.result(angle);
    }
}

export class PushUpDetector extends RepDetector {
    constructor(thresholds = PUSH_UP_THRESHOLDS) {
        super(thresholds, "Show one arm.", "Can't see hands.");
    }

    update(landmarks, now = performance.now()) {
        const candidates = [];
        for (const side of Object.values(LANDMARKS)) {
            const shoulder = landmarks?.[side.shoulder];
            const elbow = landmarks?.[side.elbow];
            const wrist = landmarks?.[side.wrist];
            if (![shoulder, elbow, wrist].every(point =>
                visible(point, this.thresholds.visibility)
            )) continue;

            const armAngle = angleAt(shoulder, elbow, wrist);
            if (armAngle == null) continue;
            candidates.push(armAngle);
        }
        if (!candidates.length) {
            this.loseTracking();
            return this.result(null);
        }

        const angle = this.filteredAngle = smoothedAngle(this.filteredAngle, average(candidates));
        const t = this.thresholds;

        if (this.state === "unknown") {
            this.feedback = "Arms straight.";
            if (angle >= t.starting) {
                this.holdTransition("starting", now, t.establishMs, () => {
                    this.state = "starting";
                    this.feedback = "Ready. Lower.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "starting") {
            this.feedback = "Ready. Lower.";
            if (angle <= t.bottom) {
                this.pendingState = null;
                this.state = "bottom";
                this.feedback = "Bottom reached.";
            } else if (angle <= t.lowering) {
                this.holdTransition("lowering", now, t.settleMs, () => {
                    this.state = "lowering";
                    this.feedback = "Keep lowering.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "lowering") {
            this.feedback = "Keep lowering.";
            if (angle <= t.bottom) {
                this.holdTransition("bottom", now, t.settleMs, () => {
                    this.state = "bottom";
                    this.feedback = "Bottom reached.";
                });
            } else if (angle >= t.starting) {
                this.holdTransition("starting", now, t.settleMs, () => {
                    this.state = "starting";
                    this.feedback = "Go lower.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "bottom") {
            this.feedback = "Bottom reached.";
            if (angle >= t.starting) {
                this.pendingState = null;
                this.count += 1;
                this.state = "starting";
                this.feedback = "Nice rep.";
            } else if (angle >= t.returning) {
                this.holdTransition("returning", now, t.settleMs, () => {
                    this.state = "returning";
                    this.feedback = "Push up.";
                });
            } else {
                this.clearPending();
            }
        } else if (this.state === "returning") {
            this.feedback = "Push up.";
            if (angle >= t.starting) {
                this.holdTransition("starting", now, t.returnMs, () => {
                    this.count += 1;
                    this.state = "starting";
                    this.feedback = "Nice rep.";
                });
            } else if (angle <= t.bottom) {
                this.holdTransition("bottom", now, t.settleMs, () => {
                    this.state = "bottom";
                    this.feedback = "Bottom reached.";
                });
            } else {
                this.clearPending();
            }
        }
        return this.result(angle);
    }
}

class AngleCycleDetector extends RepDetector {
    constructor(thresholds, initialLabel, phaseLabels, lostTrackingLabel) {
        super(thresholds, initialLabel, lostTrackingLabel);
        this.phaseLabels = phaseLabels;
    }

    updateAngle(angle, now) {
        if (!Number.isFinite(angle)) {
            this.loseTracking();
            return this.result(null);
        }
        const t = this.thresholds;
        const filtered = this.filteredAngle = smoothedAngle(this.filteredAngle, angle);
        const descending = t.start > t.bottom;

        if (this.state === "unknown") {
            this.feedback = this.initialLabel;
            const atStart = descending
                ? filtered >= t.start
                : filtered <= t.start;
            if (atStart) {
                this.holdTransition("start", now, t.establishMs, () => {
                    this.state = "start";
                    this.feedback = this.phaseLabels.start;
                });
            } else this.clearPending();
        } else if (this.state === "start") {
            this.feedback = this.phaseLabels.start;
            const movementStarted = descending
                ? filtered <= t.active
                : filtered >= t.active;
            if (movementStarted) {
                const reachedBottom = descending
                    ? filtered <= t.bottom
                    : filtered >= t.bottom;
                if (reachedBottom) {
                    this.pendingState = null;
                    this.state = "bottom";
                    this.feedback = this.phaseLabels.bottom;
                } else {
                    this.holdTransition("active", now, t.settleMs, () => {
                        this.state = "active";
                        this.feedback = this.phaseLabels.active;
                    });
                }
            } else this.clearPending();
        } else if (this.state === "active") {
            this.feedback = this.phaseLabels.active;
            const reachedBottom = descending
                ? filtered <= t.bottom
                : filtered >= t.bottom;
            if (reachedBottom) {
                this.holdTransition("bottom", now, t.settleMs, () => {
                    this.state = "bottom";
                    this.feedback = this.phaseLabels.bottom;
                });
            } else if (descending
                ? filtered >= t.start
                : filtered <= t.start) {
                this.holdTransition("start", now, t.settleMs, () => {
                    this.state = "start";
                    this.feedback = "Go deeper.";
                });
            } else this.clearPending();
        } else if (this.state === "bottom") {
            this.feedback = this.phaseLabels.bottom;
            const returnedToStart = descending
                ? filtered >= t.start
                : filtered <= t.start;
            const returning = descending
                ? filtered >= t.return
                : filtered <= t.return;
            if (returnedToStart) {
                this.pendingState = null;
                this.count += 1;
                this.state = "start";
                this.feedback = "Nice rep.";
            } else if (returning) {
                this.holdTransition("returning", now, t.settleMs, () => {
                    this.state = "returning";
                    this.feedback = this.phaseLabels.returning;
                });
            } else this.clearPending();
        } else if (this.state === "returning") {
            this.feedback = this.phaseLabels.returning;
            const returned = descending
                ? filtered >= t.start
                : filtered <= t.start;
            const returnedAgain = descending
                ? filtered <= t.bottom
                : filtered >= t.bottom;
            if (returned) {
                this.holdTransition("start", now, t.returnMs, () => {
                    this.count += 1;
                    this.state = "start";
                this.feedback = "Nice rep.";
                });
            } else if (returnedAgain) {
                this.holdTransition("bottom", now, t.settleMs, () => {
                    this.state = "bottom";
                    this.feedback = this.phaseLabels.bottom;
                });
            } else this.clearPending();
        }
        return this.result(filtered);
    }
}

function armCycleAngles(landmarks, thresholds) {
    const values = [];
    const needsHip = thresholds.name === "pull-up";
    for (const [name, side] of Object.entries(LANDMARKS)) {
        const shoulder = landmarks?.[side.shoulder];
        const elbow = landmarks?.[side.elbow];
        const wrist = landmarks?.[side.wrist];
        const hip = landmarks?.[side.hip];
        if (![shoulder, elbow, wrist].every(point =>
            visible(point, thresholds.visibility)
        ) || (needsHip && !visible(hip, thresholds.visibility))) continue;
        const angle = angleAt(shoulder, elbow, wrist);
        if (angle == null) continue;
        const upperArmLength = Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y);
        if (upperArmLength < 0.025) continue;
        values.push({ side: name, angle });
    }

    return values;
}

function shoulderRaiseAngles(landmarks, thresholds) {
    const values = [];
    for (const [name, side] of Object.entries(LANDMARKS)) {
        const shoulder = landmarks?.[side.shoulder];
        const elbow = landmarks?.[side.elbow];
        const hip = landmarks?.[side.hip];
        if (![shoulder, elbow, hip].every(point =>
            visible(point, thresholds.visibility)
        )) continue;
        const angle = angleAt(hip, shoulder, elbow);
        if (angle != null) values.push({ side: name, angle });
    }
    return values;
}

function exerciseAngleConfig(slug) {
    const config = EXERCISE_THRESHOLDS[slug];
    if (!config) return null;
    const phaseLabels = slug === "pull-ups"
        ? {
            start: "Full hang.",
            active: "Pull up.",
            bottom: "Lower slowly.",
            returning: "Full hang."
        }
        : slug === "biceps-curls"
            ? {
                start: "Arms straight.",
                active: "Curl up.",
                bottom: "Lower slowly.",
                returning: "Extend arm."
            }
            : slug === "triceps-extension"
                ? {
                    start: "Elbow bent.",
                    active: "Extend arm.",
                    bottom: "Bend slowly.",
                    returning: "Back to start."
                }
                : slug === "shoulder-press"
                    ? {
                        start: "Start low.",
                        active: "Press up.",
                        bottom: "Lower slowly.",
                        returning: "Arms down."
                    }
                    : {
                        start: "Arms down.",
                        active: "Raise arms.",
                        bottom: "Lower slowly.",
                        returning: "Arms down."
                    };
    const lostTrackingLabel = slug === "pull-ups"
        ? "Can't see hands/hips."
        : slug === "lateral-raises"
            ? "Can't see arms."
            : "Can't see hands.";

    return { config, phaseLabels, lostTrackingLabel };
}

export class ExerciseArmDetector extends AngleCycleDetector {
    constructor(slug) {
        const setup = exerciseAngleConfig(slug);
        if (!setup) throw new Error(`No arm detector configuration exists for ${slug}.`);
        super(
            setup.config,
            "Get set.",
            setup.phaseLabels,
            setup.lostTrackingLabel
        );
        this.sideDetectors = Object.fromEntries(
            Object.keys(LANDMARKS).map(side => [side, new AngleCycleDetector(
                setup.config,
                "Get set.",
                setup.phaseLabels,
                setup.lostTrackingLabel
            )])
        );
        this.lastRepAt = -Infinity;
    }

    reset(count = 0) {
        super.reset(count);
        for (const detector of Object.values(this.sideDetectors || {})) {
            detector.reset();
        }
        this.lastRepAt = -Infinity;
    }

    loseTracking() {
        super.loseTracking();
        for (const detector of Object.values(this.sideDetectors || {})) {
            detector.loseTracking();
        }
    }

    update(landmarks, now = performance.now()) {
        const angles = this.thresholds.name === "lateral raise"
            ? shoulderRaiseAngles(landmarks, this.thresholds)
            : armCycleAngles(landmarks, this.thresholds);
        const bySide = new Map(angles.map(({ side, angle }) => [side, angle]));
        const completed = [];
        for (const [side, detector] of Object.entries(this.sideDetectors)) {
            const angle = bySide.get(side);
            if (angle == null) {
                detector.loseTracking();
                continue;
            }
            const previousCount = detector.count;
            detector.updateAngle(angle, now);
            if (detector.count > previousCount) completed.push(detector);
        }

        if (completed.length && now - this.lastRepAt > 250) {
            this.count += 1;
            this.lastRepAt = now;
        }

        const activeDetectors = Object.values(this.sideDetectors)
            .filter(detector => detector.state !== "unknown");
        const current = activeDetectors.sort((first, second) =>
            ["start", "active", "bottom", "returning"].indexOf(second.state) -
            ["start", "active", "bottom", "returning"].indexOf(first.state)
        )[0];
        const angle = average(angles.map(value => value.angle));
        this.state = current?.state || "unknown";
        this.feedback = current?.feedback ||
            (angles.length ? "Get set." : this.lostTrackingLabel);
        this.filteredAngle = angle;
        return this.result(angle);
    }
}

export const JUMPING_JACK_THRESHOLDS = Object.freeze({
    visibility: VISIBILITY_THRESHOLD,
    armsDownMax: 0.45,
    armsUpMin: 0.65,
    feetClosedMax: 0.75,
    feetOpenMin: 0.95,
    settleMs: 0,
    establishMs: 160,
    returnMs: 0,
    maxFrameGapMs: 350
});

export class JumpingJackDetector extends RepDetector {
    constructor(thresholds = JUMPING_JACK_THRESHOLDS) {
        super(thresholds, "Show arms, feet.", "Can't see hands/legs.");
    }

    update(landmarks, now = performance.now()) {
        const t = this.thresholds;
        const required = [11, 12, 15, 16, 23, 24, 27, 28];
        if (!required.every(index => visible(landmarks?.[index], t.visibility))) {
            this.loseTracking();
            return this.result(null);
        }
        const shoulderWidth = Math.abs(landmarks[11].x - landmarks[12].x);
        const hipWidth = Math.abs(landmarks[23].x - landmarks[24].x);
        if (shoulderWidth < 0.025 || hipWidth < 0.015) {
            this.loseTracking();
            return this.result(null);
        }

        const armHeight = (
            (landmarks[11].y - landmarks[15].y) +
            (landmarks[12].y - landmarks[16].y)
        ) / (2 * shoulderWidth);
        const legWidth = Math.abs(landmarks[27].x - landmarks[28].x) / hipWidth;
        const armsUp = armHeight >= t.armsUpMin;
        const armsDown = armHeight <= t.armsDownMax;
        const feetOpen = legWidth >= t.feetOpenMin;
        const feetClosed = legWidth <= t.feetClosedMax;
        const jumping = armsUp || feetOpen;
        const closed = armsDown || feetClosed;

        if (this.state === "unknown") {
            this.feedback = "Feet together.";
            if (closed) {
                this.holdTransition("closed", now, t.establishMs, () => {
                    this.state = "closed";
                    this.feedback = "Ready. Jump.";
                });
            } else this.clearPending();
        } else if (this.state === "closed") {
            this.feedback = "Jump up.";
            if (jumping) {
                this.holdTransition("open", now, t.settleMs, () => {
                    this.state = "open";
                    this.feedback = "Close stance.";
                });
            } else this.clearPending();
        } else if (this.state === "open") {
            this.feedback = "Close stance.";
            if (closed) {
                this.holdTransition("closed", now, t.returnMs, () => {
                    this.count += 1;
                    this.state = "closed";
                    this.feedback = "Nice rep.";
                });
            } else this.clearPending();
        }
        return this.result(jumping ? "open" : closed ? "closed" : this.state);
    }
}

export const SKIPPING_ROPE_THRESHOLDS = Object.freeze({
    visibility: VISIBILITY_THRESHOLD,
    minFootClearance: 0.045,
    landingTolerance: 0.07,
    settleMs: 0,
    establishMs: 160,
    returnMs: 0,
    maxFrameGapMs: 300
});

export class SkippingRopeDetector extends RepDetector {
    constructor(thresholds = SKIPPING_ROPE_THRESHOLDS) {
        super(thresholds, "Show hips, ankles.", "Can't see legs.");
        this.baselineHipY = null;
    }

    reset(count = 0) {
        super.reset(count);
        this.baselineHipY = null;
    }

    resetMovement() {
        super.resetMovement();
        this.baselineHipY = null;
    }

    update(landmarks, now = performance.now()) {
        const t = this.thresholds;
        const required = [11, 12, 23, 24, 25, 26, 27, 28];
        if (!required.every(index => visible(landmarks?.[index], t.visibility))) {
            this.loseTracking();
            return this.result(null);
        }
        const leftLeg = angleAt(landmarks[23], landmarks[25], landmarks[27]);
        const rightLeg = angleAt(landmarks[24], landmarks[26], landmarks[28]);
        const hipY = (landmarks[23].y + landmarks[24].y) / 2;
        const torsoLength = (
            Math.hypot(landmarks[11].x - landmarks[23].x, landmarks[11].y - landmarks[23].y) +
            Math.hypot(landmarks[12].x - landmarks[24].x, landmarks[12].y - landmarks[24].y)
        ) / 2;
        if (leftLeg == null || rightLeg == null ||
            Math.abs(leftLeg - rightLeg) > 90 ||
            Math.abs(landmarks[27].x - landmarks[28].x) > 0.45 ||
            torsoLength < MIN_SEGMENT_LENGTH) {
            this.loseTracking();
            return this.result(null);
        }

        if (this.state === "unknown") {
            this.feedback = "Stand tall.";
            if (this.baselineHipY == null) this.baselineHipY = hipY;
            else this.baselineHipY = this.baselineHipY * 0.8 + hipY * 0.2;
            const postureReady = leftLeg > 145 && rightLeg > 145;
            if (postureReady) {
                this.holdTransition("grounded", now, t.establishMs, () => {
                    this.state = "grounded";
                    this.baselineHipY = hipY;
                    this.feedback = "Ready. Jump.";
                });
            } else this.clearPending();
        } else {
            const rise = (this.baselineHipY - hipY) / torsoLength;
            if (this.state === "grounded") {
                this.feedback = "Jump lightly.";
                if (rise >= t.minFootClearance) {
                    this.holdTransition("airborne", now, t.settleMs, () => {
                        this.state = "airborne";
                        this.feedback = "Land together.";
                    });
                } else {
                    this.clearPending();
                    this.baselineHipY = this.baselineHipY * 0.97 + hipY * 0.03;
                }
            } else if (this.state === "airborne") {
                this.feedback = "Land together.";
                if (rise <= t.landingTolerance) {
                    this.holdTransition("grounded", now, t.returnMs, () => {
                        this.count += 1;
                        this.state = "grounded";
                        this.baselineHipY = hipY;
                        this.feedback = "Nice jump.";
                    });
                } else this.clearPending();
            }
        }
        return this.result(hipY);
    }
}

export class PlankTimerDetector {
    constructor(thresholds = PLANK_THRESHOLDS) {
        this.thresholds = thresholds;
        this.reset();
    }

    reset(elapsedMs = 0) {
        this.elapsedMs = Math.max(0, Number(elapsedMs) || 0);
        this.lastValidAt = null;
        this.isCorrect = false;
        this.feedback = "Start plank.";
        this.lostTrackingLabel = "Can't see legs.";
    }

    pause() {
        this.lastValidAt = null;
        this.isCorrect = false;
    }

    update(landmarks, now = performance.now()) {
        const t = this.thresholds;
        const sideCandidates = [
            { shoulder: 11, elbow: 13, wrist: 15, hip: 23, ankle: 27 },
            { shoulder: 12, elbow: 14, wrist: 16, hip: 24, ankle: 28 }
        ];
        let hasVisibleBody = false;
        let hasVisibleSupport = false;
        let hasStableSupport = false;

        for (const side of sideCandidates) {
            const shoulder = landmarks?.[side.shoulder];
            const elbow = landmarks?.[side.elbow];
            const wrist = landmarks?.[side.wrist];
            const hip = landmarks?.[side.hip];
            const ankle = landmarks?.[side.ankle];
            if ([shoulder, hip, ankle].every(point => visible(point, t.visibility))) {
                hasVisibleBody = true;
            }
            if ([elbow, wrist].every(point => visible(point, t.visibility))) {
                hasVisibleSupport = true;
            }
            if (![shoulder, elbow, wrist, hip, ankle].every(point =>
                visible(point, t.visibility)
            )) continue;

            const deltaX = ankle.x - shoulder.x;
            const deltaY = ankle.y - shoulder.y;
            const armAngle = angleAt(shoulder, elbow, wrist);
            const bodyLength = Math.hypot(deltaX, deltaY);
            if (armAngle == null || armAngle < t.minSupportArmAngle) continue;
            hasStableSupport = true;
            if (bodyLength < t.minBodyLength) continue;
            const bodyLineAngle = Math.atan2(Math.abs(deltaY), Math.abs(deltaX)) * 180 / Math.PI;
            const hipDeviation = Math.abs(
                deltaX * (shoulder.y - hip.y) - (shoulder.x - hip.x) * deltaY
            ) / bodyLength;
            if (bodyLineAngle > t.maxBodyLineAngle || hipDeviation > bodyLength * t.maxHipDeviation) {
                continue;
            }

            if (this.lastValidAt != null) {
                const delta = now - this.lastValidAt;
                if (delta > 0 && delta <= t.maxFrameGapMs) {
                    this.elapsedMs += delta;
                }
            }
            this.lastValidAt = now;
            this.isCorrect = true;
            this.feedback = "Strong form.";
            return this.result(true);
        }

        this.pause();
        this.feedback = !hasVisibleBody
            ? this.lostTrackingLabel
            : !hasVisibleSupport
                ? "Can't see hands."
                : !hasStableSupport
                    ? "Steady arm."
                : "Straighten up.";
        return this.result(false);
    }

    result(correct) {
        return {
            count: Math.floor(this.elapsedMs / 1000),
            elapsedMs: this.elapsedMs,
            state: correct ? "holding" : "paused",
            isCorrect: correct,
            feedback: this.feedback
        };
    }
}

export function createExerciseDetector(slug) {
    if (slug === "squats") return new SquatDetector();
    if (slug === "push-ups") return new PushUpDetector();
    if (slug === "plank") return new PlankTimerDetector();
    if (slug === "jumping-jacks") return new JumpingJackDetector();
    if (slug === "skipping-rope") return new SkippingRopeDetector();
    if (EXERCISE_THRESHOLDS[slug]) return new ExerciseArmDetector(slug);
    return null;
}
