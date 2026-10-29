import {
    getCameraMirrorPreference,
    setCameraMirrorPreference
} from "./camera-preference.js";

const toggle = document.getElementById("cameraMirrorToggle");
const status = document.getElementById("cameraSettingStatus");
const dangerZone = document.getElementById("dangerZone");
const deleteAccountButton = document.getElementById("deleteAccountButton");
const deleteAccountStatus = document.getElementById("deleteAccountStatus");

function hasSignedInUser() {
    try {
        return Boolean(
            localStorage.getItem("token") &&
            JSON.parse(localStorage.getItem("user") || "null")
        );
    } catch {
        return false;
    }
}

dangerZone.hidden = !hasSignedInUser();

toggle.checked = getCameraMirrorPreference();

toggle.addEventListener("change", () => {
    const saved = setCameraMirrorPreference(toggle.checked);

    if (!saved) {
        toggle.checked = getCameraMirrorPreference();
    }

    status.textContent = saved ? "Saved." : "Could not save.";
});

deleteAccountButton.addEventListener("click", async () => {
    const confirmed = window.confirm(
        "Delete your account permanently? This will also delete your profile, workouts, and competition links. This action cannot be undone."
    );
    if (!confirmed) return;

    deleteAccountButton.disabled = true;
    deleteAccountStatus.textContent = "Deleting account…";

    try {
        const response = await fetch(`${window.API_URL}/api/account`, {
            method: "DELETE",
            headers: {
                Authorization: `Bearer ${localStorage.getItem("token")}`
            }
        });
        const data = await response.json().catch(() => ({}));

        if (response.status === 401) {
            window.clearPrivateCaches();
            localStorage.removeItem("token");
            localStorage.removeItem("user");
            window.location.replace("/blog");
            return;
        }
        if (!response.ok) {
            throw new Error(data.message || "Could not delete your account.");
        }

        window.clearPrivateCaches();
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        deleteAccountStatus.textContent = "Account deleted. Redirecting…";
        window.setTimeout(() => window.location.replace("/blog"), 600);
    } catch (error) {
        console.error("Account deletion error:", error);
        deleteAccountStatus.textContent = error instanceof TypeError
            ? "Could not reach the server. Please try again."
            : error.message || "Could not delete your account.";
        deleteAccountButton.disabled = false;
    }
});
