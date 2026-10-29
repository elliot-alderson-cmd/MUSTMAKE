import {
    getCameraMirrorPreference,
    setCameraMirrorPreference
} from "./camera-preference.js";

const toggle = document.getElementById("cameraMirrorToggle");
const status = document.getElementById("cameraSettingStatus");

toggle.checked = getCameraMirrorPreference();

toggle.addEventListener("change", () => {
    const saved = setCameraMirrorPreference(toggle.checked);

    if (!saved) {
        toggle.checked = getCameraMirrorPreference();
    }

    status.textContent = saved ? "Saved." : "Could not save.";
});
