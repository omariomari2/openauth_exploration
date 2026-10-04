import { ui, clearPersonalData, disableActions, showProfile } from "./view.mjs";
/** @typedef {import("./view.mjs").Session} Session */
/** @type {Session|null} */
let session = null;
/** @type {Session|null} */
let confirmation = null;
/** @type {"idle"|"loading"|"ready"|"mutating"|"locked"} */
let phase = "idle";
let generation = 0;

function cancelConfirmation() {
  confirmation = null;
  ui.confirmation.hidden = true;
  ui.deleteEmail.textContent = "";
}
function forgetSession() {
  session = null;
  cancelConfirmation();
  clearPersonalData();
}
/** @param {string} message */
function showSignIn(message) {
  forgetSession();
  phase = "idle";
  ui.retry.hidden = true;
  ui.signedOut.hidden = false;
  ui.status.textContent = message;
}
/** @param {Session|null} previous @param {Session} next */
function sameSession(previous, next) {
  return previous !== null && previous.user.id === next.user.id && previous.csrfToken === next.csrfToken;
}
/** @param {Response} response @returns {Promise<Session>} */
async function readProfile(response) {
  const data = await response.json();
  if (!data || typeof data.csrfToken !== "string" || !data.csrfToken ||
    typeof data.user?.id !== "string" || !data.user.id || typeof data.user.email !== "string" ||
    ![data.user.firstName, data.user.lastName].every((name) => name === null || typeof name === "string")) {
    throw new Error("Profile unavailable");
  }
  return data;
}
/** @param {string} path @param {RequestInit} [options] */
function request(path, options = {}) {
  return fetch(path, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(10_000) });
}
/** @param {boolean} [background] */
async function loadProfile(background = false) {
  if (["loading", "mutating", "locked"].includes(phase) || document.hidden) return;
  const previous = session;
  const dirty = previous && (ui.firstName.value !== (previous.user.firstName ?? "") ||
    ui.lastName.value !== (previous.user.lastName ?? ""));
  const version = ++generation;
  phase = "loading";
  cancelConfirmation();
  if (!background) forgetSession();
  disableActions(true);
  ui.retry.hidden = true;
  ui.signedOut.hidden = true;
  if (!background) ui.status.textContent = "Checking your session…";
  try {
    const response = await request("/api/profile");
    if (version !== generation) return;
    if (response.status === 401 || response.status === 403) {
      showSignIn("Sign in to open your private profile.");
      return;
    }
    if (!response.ok) throw new Error("Profile unavailable");
    const current = await readProfile(response);
    if (version !== generation) return;
    // Keep a dirty draft AND its baseline only within the same account/session.
    if (!(background && dirty && sameSession(previous, current))) {
      forgetSession();
      session = current;
      showProfile(current.user);
      ui.status.textContent = "Your private profile is ready.";
    }
  } catch {
    if (version !== generation) return;
    forgetSession();
    ui.status.textContent = "Could not load your profile. Please try again.";
    ui.retry.hidden = false;
  } finally {
    if (version === generation && phase === "loading") {
      phase = session ? "ready" : "idle";
      disableActions(!session);
    }
  }
}
function lockUncertainAction() {
  showSignIn("We could not confirm the last action. Sign in again before making more changes.");
  phase = "locked";
  ui.status.focus();
}

/** @param {"save"|"logout"|"delete"} action @param {Record<string, string|null>} [patch] */
async function mutate(action, patch) {
  if (phase !== "ready" || !session) return;
  const captured = session;
  const version = ++generation;
  phase = "mutating";
  cancelConfirmation();
  disableActions(true);
  ui.status.textContent = action === "save" ? "Saving changes…" : action === "delete" ? "Deleting your account…" : "Signing out…";
  try {
    const response = await request(action === "save" ? "/api/profile" : action === "delete" ? "/api/account" : "/logout", {
      method: action === "save" ? "PATCH" : action === "delete" ? "DELETE" : "POST",
      headers: { "X-CSRF-Token": captured.csrfToken, ...(action === "save" ? { "Content-Type": "application/json" } : {}) },
      ...(action === "save" ? { body: JSON.stringify(patch) } : {}),
    });
    if (version !== generation) return;
    if (response.status === 401 || response.status === 403) {
      showSignIn("Your session changed or expired. Sign in again to continue.");
      ui.status.focus();
      return;
    }
    if (action === "save" && response.status === 400 && (await response.json()).error === "invalid_profile") {
      if (version !== generation) return;
      ui.status.textContent = "Names must be at most 100 characters without control characters. Your changes were not saved.";
      ui.status.focus();
      return;
    }
    if (action === "save" && response.status === 200) {
      const saved = await readProfile(response);
      if (version !== generation) return;
      if (!sameSession(captured, saved)) throw new Error("Session changed");
      session = saved;
      showProfile(saved.user);
      ui.status.textContent = "Changes saved.";
    } else if (action !== "save" && response.status === 204) {
      showSignIn(action === "delete" ? "Your demo account was deleted." : "Signed out of this demo.");
      ui.status.focus();
    } else throw new Error("Action outcome unknown");
  } catch {
    if (version === generation) lockUncertainAction();
  } finally {
    if (version === generation && phase === "mutating") {
      phase = session ? "ready" : "idle";
      disableActions(!session);
    }
  }
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (phase !== "ready" || !session) return;
  /** @type {Record<string, string|null>} */
  const patch = {};
  for (const field of ["firstName", "lastName"]) {
    const key = /** @type {"firstName"|"lastName"} */ (field);
    if (ui[key].value !== (session.user[key] ?? "")) patch[key] = ui[key].value || null;
  }
  if (!Object.keys(patch).length) { ui.status.textContent = "No changes to save."; return; }
  void mutate("save", patch);
});
ui.logout.addEventListener("click", () => { void mutate("logout"); });
ui.deleteOpen.addEventListener("click", () => {
  if (phase !== "ready" || !session) return;
  confirmation = session;
  ui.deleteEmail.textContent = session.user.email;
  ui.confirmation.hidden = false;
  ui.confirmation.focus();
});
ui.deleteCancel.addEventListener("click", () => { cancelConfirmation(); ui.deleteOpen.focus(); });
ui.deleteConfirm.addEventListener("click", () => {
  if (phase !== "ready" || !session || !sameSession(confirmation, session)) { cancelConfirmation(); return; }
  void mutate("delete");
});
ui.retry.addEventListener("click", () => { void loadProfile(); });
ui.refresh.addEventListener("click", () => { void loadProfile(); });

// Clear private DOM before history caching or hiding; revalidate on return.
// https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
// https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event
function suspend() {
  const uncertain = phase === "mutating" || phase === "locked";
  ++generation;
  forgetSession();
  phase = "idle";
  ui.retry.hidden = true;
  ui.signedOut.hidden = true;
  ui.status.textContent = "Checking your session…";
  if (uncertain) lockUncertainAction();
}
window.addEventListener("pagehide", suspend);
window.addEventListener("pageshow", (event) => { if (event.persisted) void loadProfile(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) suspend(); else void loadProfile(); });
setInterval(() => { if (phase === "ready") void loadProfile(true); }, 60_000);
void loadProfile();
