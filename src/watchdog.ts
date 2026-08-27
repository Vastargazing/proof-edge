export interface WatchdogObservation {
  forecasts: number;
  anchors: number;
  recorder_active: boolean;
}

export interface WatchdogState {
  forecasts: number;
  anchors: number;
  consecutive_ticks_without_forecast: number;
  consecutive_ticks_without_anchor: number;
}

export interface WatchdogResult {
  state: WatchdogState;
  alerts: string[];
}

const checkedCount = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
};

/** Pure two-tick liveness policy; persistence and alert delivery live in the runner. */
export function evaluateWatchdogTick(
  previous: WatchdogState | null,
  observation: WatchdogObservation,
  threshold = 2,
): WatchdogResult {
  const forecasts = checkedCount("forecasts", observation.forecasts);
  const anchors = checkedCount("anchors", observation.anchors);
  if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new Error("threshold must be a positive safe integer");

  if (previous !== null) {
    checkedCount("previous forecasts", previous.forecasts);
    checkedCount("previous anchors", previous.anchors);
    checkedCount("previous forecast silence", previous.consecutive_ticks_without_forecast);
    checkedCount("previous anchor silence", previous.consecutive_ticks_without_anchor);
  }

  const noForecast = previous === null || forecasts > previous.forecasts
    ? 0
    : previous.consecutive_ticks_without_forecast + 1;
  const noAnchor = previous === null || anchors > previous.anchors
    ? 0
    : previous.consecutive_ticks_without_anchor + 1;
  const alerts: string[] = [];

  if (!observation.recorder_active) alerts.push("recorder_service_down");
  if (previous !== null && forecasts < previous.forecasts) {
    alerts.push(`forecast_count_regressed previous=${previous.forecasts} current=${forecasts}`);
  }
  if (previous !== null && anchors < previous.anchors) {
    alerts.push(`anchor_count_regressed previous=${previous.anchors} current=${anchors}`);
  }
  if (noForecast >= threshold) alerts.push(`no_new_forecast_windows ticks=${noForecast} forecasts=${forecasts}`);
  if (noAnchor >= threshold) alerts.push(`no_new_anchors ticks=${noAnchor} anchors=${anchors}`);

  return {
    state: {
      forecasts,
      anchors,
      consecutive_ticks_without_forecast: noForecast,
      consecutive_ticks_without_anchor: noAnchor,
    },
    alerts,
  };
}
