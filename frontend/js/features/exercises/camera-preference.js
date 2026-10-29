const CAMERA_MIRROR_KEY_PREFIX = "mustmake_camera_mirror:";
const CAMERA_PREFERENCE_CHANGE_EVENT = "mustmake:camera-preference-change";

export function getCameraMirrorPreferenceKey() {
    let user = null;

    try {
        user = JSON.parse(localStorage.getItem("user") || "null");
    } catch {
        // Use the separate guest preference when no readable account is stored.
    }

    const identity = user?._id ?? user?.id ?? user?.email ?? user?.username;
    const userKey = identity == null
        ? "guest"
        : String(identity).trim().toLowerCase();

    return `${CAMERA_MIRROR_KEY_PREFIX}${encodeURIComponent(userKey)}`;
}

export function getCameraMirrorPreference() {
    try {
        return localStorage.getItem(getCameraMirrorPreferenceKey()) !== "false";
    } catch {
        return true;
    }
}

export function setCameraMirrorPreference(mirrored) {
    const value = Boolean(mirrored);

    try {
        localStorage.setItem(
            getCameraMirrorPreferenceKey(),
            String(value)
        );
    } catch (error) {
        console.warn("Could not save the camera preview preference.", error);
        return false;
    }

    window.dispatchEvent(new CustomEvent(CAMERA_PREFERENCE_CHANGE_EVENT, {
        detail: { mirrored: value }
    }));

    return true;
}

export { CAMERA_PREFERENCE_CHANGE_EVENT };
