(() => {
    "use strict";

    const DEFAULT_DURATION = 3600;
    const PENDING_TOAST_KEY = "mustmake_pending_toast";
    const PENDING_FINISH_SOUND_KEY = "mustmake_pending_finish_sound";
    const EXERCISE_SOUND_KEY_PREFIX = "mustmake_exercise_sound:";
    const toastSound = new Audio("/assets/toaster.mp3");
    const finishSound = new Audio("/assets/finishsession.mp3");
    toastSound.preload = "auto";
    finishSound.preload = "auto";
    const icons = {
        success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
        error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
        warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></svg>',
        info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>'
    };

    function playToastSound() {
        if (!getExerciseSoundPreference()) return;

        toastSound.currentTime = 0;
        toastSound.play().catch(error => {
            console.warn("Could not play the notification sound.", error);
        });
    }

    function getExerciseSoundPreference() {
        try {
            let user = null;
            try {
                user = JSON.parse(localStorage.getItem("user") || "null");
            } catch {
                // Use the separate guest preference when account data is unavailable.
            }
            const identity = user?._id ?? user?.id ?? user?.email ?? user?.username;
            const userKey = identity == null
                ? "guest"
                : String(identity).trim().toLowerCase();
            return localStorage.getItem(
                `${EXERCISE_SOUND_KEY_PREFIX}${encodeURIComponent(userKey)}`
            ) !== "false";
        } catch {
            return true;
        }
    }

    function playPendingFinishSound() {
        try {
            if (sessionStorage.getItem(PENDING_FINISH_SOUND_KEY) !== "true") return;
            sessionStorage.removeItem(PENDING_FINISH_SOUND_KEY);
        } catch (error) {
            console.warn("Could not read the pending session finish sound.", error);
            return;
        }

        if (!getExerciseSoundPreference()) return;

        finishSound.currentTime = 0;
        finishSound.play().catch(error => {
            if (error?.name !== "NotAllowedError") {
                console.warn("Could not play the session finish sound.", error);
                return;
            }

            const resumeOnInteraction = () => {
                document.removeEventListener("pointerdown", resumeOnInteraction);
                document.removeEventListener("keydown", resumeOnInteraction);
                if (!getExerciseSoundPreference()) return;
                finishSound.play().catch(playError => {
                    console.warn("Could not play the session finish sound.", playError);
                });
            };
            document.addEventListener("pointerdown", resumeOnInteraction, { once: true });
            document.addEventListener("keydown", resumeOnInteraction, { once: true });
        });
    }

    function getToastRoot() {
        let root = document.querySelector(".toast-viewport");
        if (!root) {
            root = document.createElement("div");
            root.className = "toast-viewport";
            root.setAttribute("role", "region");
            root.setAttribute("aria-label", "Notifications");
            document.body.appendChild(root);
        }
        return root;
    }

    function normalizeType(type) {
        return ["success", "error", "warning", "info", "loading"].includes(type)
            ? type
            : "info";
    }

    function showToast(message, options = {}) {
        if (!document.body || message == null || String(message).trim() === "") {
            return null;
        }

        const root = getToastRoot();
        if (root.children.length >= 4) {
            const dismissibleToast = Array.from(root.children)
                .find(toast => toast.dataset.type !== "loading");
            dismissibleToast?.dismissToast?.();
        }

        const toast = document.createElement("article");
        toast.className = "mustmake-toast";

        const icon = document.createElement("span");
        icon.className = "toast-icon";
        icon.setAttribute("aria-hidden", "true");

        const body = document.createElement("div");
        body.className = "toast-body";

        const text = document.createElement("p");
        text.className = "toast-message";

        const actions = document.createElement("div");
        actions.className = "toast-actions";

        const close = document.createElement("button");
        close.className = "toast-close";
        close.type = "button";
        close.setAttribute("aria-label", "Dismiss notification");
        close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

        body.append(text, actions);
        toast.append(icon, body, close);
        root.appendChild(toast);

        let timer = null;
        let dismissed = false;
        let type = "info";

        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            window.clearTimeout(timer);
            toast.classList.add("is-leaving");
            window.setTimeout(() => toast.remove(), 220);
        };

        const renderActions = nextActions => {
            actions.replaceChildren();
            const list = Array.isArray(nextActions)
                ? nextActions
                : nextActions
                    ? [nextActions]
                    : [];

            list.forEach(action => {
                if (!action || !action.label) return;
                const element = action.href
                    ? document.createElement("a")
                    : document.createElement("button");
                element.className = "toast-action";
                element.textContent = String(action.label);
                if (action.href) {
                    element.href = action.href;
                } else {
                    element.type = "button";
                    element.addEventListener("click", () => action.onClick?.());
                }
                actions.appendChild(element);
            });
        };

        const update = (nextMessage, nextOptions = {}) => {
            if (dismissed || !toast.isConnected) return handle;

            window.clearTimeout(timer);
            type = normalizeType(nextOptions.type || type);
            toast.dataset.type = type;
            toast.setAttribute("role", type === "error" ? "alert" : "status");
            text.textContent = String(nextMessage ?? "");
            if (type !== "loading") {
                playToastSound();
            }
            icon.classList.toggle("is-loading", type === "loading");
            icon.innerHTML = type === "loading"
                ? '<span class="toast-spinner"></span>'
                : icons[type];
            renderActions(nextOptions.actions || nextOptions.action);

            const duration = type === "loading"
                ? 0
                : Math.min(4000, Math.max(3000, Number(nextOptions.duration) || DEFAULT_DURATION));
            if (duration > 0) timer = window.setTimeout(dismiss, duration);
            return handle;
        };

        const handle = { element: toast, dismiss, update };
        toast.dismissToast = dismiss;
        close.addEventListener("click", dismiss);
        update(message, options);
        return handle;
    }

    function queueToast(message, type = "success") {
        try {
            sessionStorage.setItem(PENDING_TOAST_KEY, JSON.stringify({
                message: String(message),
                type: normalizeType(type),
                createdAt: Date.now()
            }));
        } catch (error) {
            console.warn("Could not queue a notification for the next page.", error);
        }
    }

    function showQueuedToast() {
        playPendingFinishSound();
        try {
            const pending = JSON.parse(sessionStorage.getItem(PENDING_TOAST_KEY) || "null");
            sessionStorage.removeItem(PENDING_TOAST_KEY);
            if (
                pending &&
                typeof pending.message === "string" &&
                Date.now() - pending.createdAt < 30000
            ) {
                showToast(pending.message, { type: pending.type });
            }
        } catch (error) {
            console.warn("Could not read the queued notification.", error);
        }
    }

    window.showToast = showToast;
    window.queueToast = queueToast;
    window.MUSTMAKE = window.MUSTMAKE || {};
    window.MUSTMAKE.toast = showToast;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", showQueuedToast, { once: true });
    } else {
        showQueuedToast();
    }
})();
