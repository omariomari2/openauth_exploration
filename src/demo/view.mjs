/** @typedef {{id: string, email: string, firstName: string|null, lastName: string|null}} Profile */
/** @typedef {{user: Profile, csrfToken: string}} Session */

/** @template {HTMLElement} T @param {string} id @param {new (...args: never[]) => T} type */
function element(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error("Demo interface unavailable");
  return node;
}

export const ui = {
  status: element("status", HTMLElement), retry: element("retry", HTMLButtonElement),
  signedOut: element("signed-out", HTMLElement), account: element("account", HTMLElement),
  email: element("email", HTMLElement), id: element("account-id", HTMLElement),
  firstName: element("first-name", HTMLInputElement), lastName: element("last-name", HTMLInputElement),
  form: element("profile-form", HTMLFormElement), fields: element("profile-fields", HTMLFieldSetElement),
  logout: element("logout", HTMLButtonElement), refresh: element("refresh", HTMLButtonElement),
  deleteOpen: element("delete-open", HTMLButtonElement), deleteConfirm: element("delete-confirm", HTMLButtonElement),
  deleteCancel: element("delete-cancel", HTMLButtonElement), confirmation: element("delete-confirmation", HTMLElement),
  deleteEmail: element("delete-email", HTMLElement),
};

/** @param {boolean} disabled */
export function disableActions(disabled) {
  ui.fields.disabled = disabled;
  for (const button of [ui.logout, ui.refresh, ui.deleteOpen, ui.deleteConfirm, ui.deleteCancel]) button.disabled = disabled;
}

export function clearPersonalData() {
  ui.account.hidden = true;
  ui.email.textContent = ui.id.textContent = ui.deleteEmail.textContent = "";
  ui.firstName.value = ui.lastName.value = "";
  ui.confirmation.hidden = true;
  disableActions(true);
}

/** @param {Profile} user */
export function showProfile(user) {
  ui.email.textContent = user.email;
  ui.id.textContent = user.id;
  ui.firstName.value = user.firstName ?? "";
  ui.lastName.value = user.lastName ?? "";
  ui.signedOut.hidden = true;
  ui.account.hidden = false;
}
