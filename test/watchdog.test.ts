import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWatchdogTick } from "../src/watchdog.js";

test("watchdog alerts after two consecutive ticks without windows or anchors", () => {
  const baseline = evaluateWatchdogTick(null, { forecasts: 10, anchors: 5, recorder_active: true });
  assert.deepEqual(baseline.alerts, []);

  const firstSilent = evaluateWatchdogTick(baseline.state, { forecasts: 10, anchors: 5, recorder_active: true });
  assert.deepEqual(firstSilent.alerts, []);
  assert.equal(firstSilent.state.consecutive_ticks_without_forecast, 1);
  assert.equal(firstSilent.state.consecutive_ticks_without_anchor, 1);

  const secondSilent = evaluateWatchdogTick(firstSilent.state, { forecasts: 10, anchors: 5, recorder_active: true });
  assert.ok(secondSilent.alerts.some((alert) => alert.startsWith("no_new_forecast_windows ticks=2")));
  assert.ok(secondSilent.alerts.some((alert) => alert.startsWith("no_new_anchors ticks=2")));
});

test("watchdog resets each progress counter independently", () => {
  const previous = {
    forecasts: 10,
    anchors: 5,
    consecutive_ticks_without_forecast: 1,
    consecutive_ticks_without_anchor: 1,
  };
  const result = evaluateWatchdogTick(previous, { forecasts: 11, anchors: 5, recorder_active: true });
  assert.equal(result.state.consecutive_ticks_without_forecast, 0);
  assert.equal(result.state.consecutive_ticks_without_anchor, 2);
  assert.ok(!result.alerts.some((alert) => alert.startsWith("no_new_forecast_windows")));
  assert.ok(result.alerts.some((alert) => alert.startsWith("no_new_anchors")));
});

test("watchdog alerts immediately when the recorder service is down", () => {
  const result = evaluateWatchdogTick(null, { forecasts: 10, anchors: 5, recorder_active: false });
  assert.deepEqual(result.alerts, ["recorder_service_down"]);
});
