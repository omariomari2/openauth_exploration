import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadWorkerModules } from "./worker.mjs";

export async function loadVisibilityWorkerModules() {
  const modules = await loadWorkerModules();
  const clients = modules.filter((module) => module.type === "Text" && /[a-f0-9]{40}-client\.mjs$/.test(module.path));
  assert.equal(clients.length, 1, "the current Worker bundle must import exactly one canonical client Text asset");
  const client = clients[0];
  const source = await readFile(client.path, "utf8");
  for (const declaration of ["async function loadProfile(background = false) {", "async function mutate(action, patch) {"]) {
    assert.equal(source.split(declaration).length, 2, `the completion observer requires exactly one ${declaration}`);
  }
  assert.ok(!source.includes("__visibilityHandlerCompletions"), "completion instrumentation must remain test-only");
  // Append observers only to the in-memory Text module served by this suite.
  // Original handlers, requests, parsing, lifecycle code and headers stay intact.
  // Awaiting each unchanged original includes its catches/finally and any awaited
  // response.json(). IDs distinguish an old request from newer requests that
  // finish first; no payload, identity or credential data enters the observer.
  client.contents = `${source}\n
window.__visibilityHandlerCompletions = {
  loadProfile: { started: 0, completed: [] },
  mutate: { started: 0, completed: [] },
};
function observeVisibilityHandler(name, original) {
  return async function (...args) {
    const state = window.__visibilityHandlerCompletions[name];
    const id = ++state.started;
    try { return await Reflect.apply(original, this, args); }
    finally { state.completed.push(id); }
  };
}
loadProfile = observeVisibilityHandler("loadProfile", loadProfile);
mutate = observeVisibilityHandler("mutate", mutate);
`;
  return modules;
}

export async function nextHandlerCompletion(page, name) {
  assert.ok(["loadProfile", "mutate"].includes(name));
  const id = await page.evaluate((name) => window.__visibilityHandlerCompletions?.[name]?.started + 1, name);
  assert.ok(Number.isSafeInteger(id) && id > 0, "the client completion observer must be installed before the action");
  return async () => {
    await page.waitForFunction(({ name, id }) => window.__visibilityHandlerCompletions[name].completed.includes(id),
      { name, id }, { polling: 10, timeout: 5000 });
  };
}

// Playwright 1.63.0 enables focus emulation on its own CDP session, which keeps
// document.hidden false even after Page.setWebLifecycleState("frozen"). Another
// CDP session cannot undo that session's override. Keep this pinned-version
// dependency isolated and fail loudly if Playwright changes its internal shape.
// https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled
// https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setWebLifecycleState
export async function controlVisibility(page) {
  const session = page._connection?.toImpl?.(page)?.delegate?._mainFrameSession?._client;
  assert.equal(typeof session?.send, "function", "Playwright 1.63.0 must expose its original CDP session for visibility tests");
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  assert.equal(await page.evaluate(() => document.hidden), false);
  await page.evaluate(() => {
    window.visibilityWitness = { marker: crypto.randomUUID(), events: [], pagehides: 0 };
    window.addEventListener("pagehide", () => { window.visibilityWitness.pagehides++; });
    // Registered after the app, so each snapshot observes its synchronous work.
    document.addEventListener("visibilitychange", (event) => {
      window.visibilityWitness.events.push({ trusted: event.isTrusted, hidden: document.hidden,
        cleared: ["email", "account-id", "delete-email"].every((id) => document.getElementById(id).textContent === "") &&
          ["first-name", "last-name"].every((id) => document.getElementById(id).value === ""),
        privateHidden: document.getElementById("account").hidden && document.getElementById("delete-confirmation").hidden,
        disabled: ["profile-fields", "logout", "delete-open", "delete-confirm"].every((id) => document.getElementById(id).disabled),
      });
    });
  });
  const marker = await page.evaluate(() => window.visibilityWitness.marker);
  async function assertSameDocument() {
    const witness = await page.evaluate(() => window.visibilityWitness);
    assert.equal(witness.marker, marker, "the original document remains alive");
    assert.equal(witness.pagehides, 0, "visibility coverage must not depend on navigation teardown");
    assert.ok(witness.events.every((event) => event.trusted), "Chromium, not dispatchEvent, emits every visibility event");
    return witness;
  }
  return {
    async hide() {
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await session.send("Page.setWebLifecycleState", { state: "frozen" });
      // Resume execution while retaining Chromium's hidden state. Responses can
      // now settle in a still-live hidden document, unlike a navigation test.
      await session.send("Page.setWebLifecycleState", { state: "active" });
      await page.waitForFunction(() => document.hidden && window.visibilityWitness.events.at(-1)?.hidden);
      const witness = await assertSameDocument();
      assert.deepEqual(witness.events.at(-1), { trusted: true, hidden: true, cleared: true, privateHidden: true, disabled: true });
    },
    async show() {
      // Restore the harness's default focus emulation. This is a trusted
      // Chromium visibility transition, not proof of a physical tab switch.
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.waitForFunction(() => !document.hidden && window.visibilityWitness.events.at(-1)?.hidden === false);
      await assertSameDocument();
    },
    assertSameDocument,
  };
}
