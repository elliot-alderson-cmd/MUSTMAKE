import {
    getCameraMirrorPreference,
    setCameraMirrorPreference
} from "./camera-preference.js";

const toggle = document.getElementById("cameraMirrorToggle");
const dangerZone = document.getElementById("dangerZone");
const deleteAccountButton = document.getElementById("deleteAccountButton");

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

    window.showToast(
        saved ? "Camera preference saved." : "Could not save camera preference.",
        { type: saved ? "success" : "error" }
    );
});

deleteAccountButton.addEventListener("click", async () => {
    const confirmed = window.confirm(
        "Delete your account permanently? This will also delete your profile, workouts, and competition links. This action cannot be undone."
    );
    if (!confirmed) return;

    deleteAccountButton.disabled = true;
    const deleteToast = window.showToast("Deleting account…", { type: "loading" });

    try {
        const response = await fetch(`${window.API_URL}/api/account`, {
            method: "DELETE",
            headers: {
                Authorization: `Bearer ${localStorage.getItem("token")}`
            }
        });
        const data = await response.json().catch(() => ({}));

        if (response.status === 401) {
            deleteToast?.dismiss();
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
        deleteToast?.dismiss();
        window.queueToast("Account deleted successfully.", "success");
        window.setTimeout(() => window.location.replace("/blog"), 600);
    } catch (error) {
        console.error("Account deletion error:", error);
        deleteToast?.update(error instanceof TypeError
            ? "Could not reach the server. Please try again."
            : error.message || "Could not delete your account.", { type: "error" });
        deleteAccountButton.disabled = false;
    }
});
