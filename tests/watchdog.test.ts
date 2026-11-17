import { test } from "node:test";
import assert from "node:assert/strict";
import { repairPlan } from "../lib/watchdog.mjs";

const healthy = { wanted: true, foreign: false, tunnelAlive: true, appAlive: true, appMatchesTunnel: true, localOk: true, publicOk: true, internetOk: true, previousPublicFailures: 0 };

test("auto-restart leaves a healthy, stopped or local-only setup alone", () => {
  assert.deepEqual(repairPlan(healthy), { skip: null, replaceTunnel: false, startTunnel: false, restartApp: false, publicFailures: 0 });
  assert.deepEqual(repairPlan({ ...healthy, wanted: false, tunnelAlive: false, appAlive: false }), { skip: "stopped" });
  assert.deepEqual(repairPlan({ ...healthy, foreign: true, tunnelAlive: false, appAlive: false }), { skip: "foreign" });
});

test("auto-restart restarts only what stopped, and moves the app when the tunnel changes", () => {
  const appDown = repairPlan({ ...healthy, appAlive: false, appMatchesTunnel: false, localOk: false });
  assert.equal(appDown.startTunnel, false, "A dead app alone never changes the link");
  assert.equal(appDown.restartApp, true);
  const hung = repairPlan({ ...healthy, localOk: false, publicOk: false });
  assert.deepEqual([hung.startTunnel, hung.restartApp], [false, true]);
  const tunnelDown = repairPlan({ ...healthy, tunnelAlive: false, appMatchesTunnel: false, publicOk: false });
  assert.deepEqual([tunnelDown.startTunnel, tunnelDown.restartApp], [true, true]);
  const bothDown = repairPlan({ ...healthy, tunnelAlive: false, appAlive: false, appMatchesTunnel: false, localOk: false, publicOk: false });
  assert.deepEqual([bothDown.startTunnel, bothDown.restartApp], [true, true]);
});

test("a live tunnel whose link stops answering is replaced only after repeated failures while the internet works", () => {
  const first = repairPlan({ ...healthy, publicOk: false });
  assert.deepEqual(first, { skip: "waiting", replaceTunnel: false, startTunnel: false, restartApp: false, publicFailures: 1 });
  const second = repairPlan({ ...healthy, publicOk: false, previousPublicFailures: first.publicFailures });
  assert.deepEqual(second, { skip: null, replaceTunnel: true, startTunnel: true, restartApp: true, publicFailures: 0 });
  const offline = repairPlan({ ...healthy, publicOk: false, internetOk: false, previousPublicFailures: 1 });
  assert.equal(offline.replaceTunnel, false, "An offline PC never changes the link; cloudflared reconnects by itself");
  assert.equal(offline.publicFailures, 1);
  assert.equal(repairPlan({ ...healthy, previousPublicFailures: 1 }).publicFailures, 0, "One good check resets the count");
});
