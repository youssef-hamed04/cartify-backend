"""Prophet as a per-series forecasting candidate (free, MIT licence).

Unlike the global ML models, Prophet fits one model per product x location series: trend plus yearly
and weekly seasonality. Sold-out days are left out of the fit, so a stockout is not learnt as zero
demand (the same rule as the ML target). One fit at a forecast date gives the daily path for every
horizon, so fits are cached by (series, date) and run in parallel processes.

Settings (environment):
    FORECAST_PROPHET=off            skip this candidate (faster runs)
    FORECAST_PROPHET_EVAL_DATES=3   test forecast dates per horizon used to score Prophet
    FORECAST_WORKERS=<cpu count>    parallel processes for the fits
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ProcessPoolExecutor
from datetime import date

import numpy as np

MIN_FIT_DAYS = 56  # fewer in-stock days than this: use the 28-day moving average instead
LABEL = "Prophet (per series: trend + yearly and weekly seasonality)"
log = logging.getLogger("forecast.prophet")


def enabled() -> bool:
    if os.environ.get("FORECAST_PROPHET", "on").lower() in ("off", "0", "false", "no"):
        return False
    try:
        import prophet  # noqa: F401
    except Exception as exc:  # not installed or broken install: the other candidates still run
        log.warning("Prophet candidate skipped: %s", exc)
        return False
    return True


def eval_dates() -> int:
    try:
        return max(1, int(os.environ.get("FORECAST_PROPHET_EVAL_DATES", "3")))
    except ValueError:
        return 3


def _workers() -> int:
    try:
        return max(1, int(os.environ.get("FORECAST_WORKERS", "0")) or (os.cpu_count() or 1))
    except ValueError:
        return os.cpu_count() or 1


def _quiet() -> None:
    """cmdstanpy logs two INFO lines per fit and installs its own handler when none exists."""
    try:
        from cmdstanpy.utils import get_logger
        get_logger()  # creates cmdstanpy's handler now, so the levels below stick
    except Exception:
        pass
    for name in ("cmdstanpy", "prophet"):
        lg = logging.getLogger(name)
        lg.setLevel(logging.WARNING)
        for h in lg.handlers:
            h.setLevel(logging.WARNING)


def fit_path(task) -> np.ndarray | None:
    """Fit Prophet on one series' in-stock days up to `origin`; return the predicted daily demand for
    the next `steps` days (clipped at 0), or None when there is too little data."""
    start, days, sales, origin, steps = task
    if len(days) < MIN_FIT_DAYS:
        return None
    import pandas as pd
    from prophet import Prophet

    _quiet()
    base = pd.Timestamp(start)
    df = pd.DataFrame({"ds": base + pd.to_timedelta(days, unit="D"), "y": sales})
    model = Prophet(yearly_seasonality=bool(days[-1] - days[0] >= 365), weekly_seasonality=True,
                    daily_seasonality=False)
    model.fit(df)
    future = pd.DataFrame({"ds": base + pd.to_timedelta(np.arange(origin + 1, origin + steps + 1), unit="D")})
    return model.predict(future)["yhat"].clip(lower=0).to_numpy(dtype=float)


def fit_task(series, origin: int, steps: int, calendar_start: date):
    days = np.arange(series.first_listed, origin + 1)
    keep = series.avail[days] > 0
    return (calendar_start.isoformat(), days[keep], series.sales[days][keep], int(origin), int(steps))


class ProphetRunner:
    """Caches Prophet fits by (series, forecast date); every fit predicts `max_steps` days ahead."""

    def __init__(self, calendar_start: date, max_steps: int, workers: int | None = None) -> None:
        self.calendar_start, self.max_steps = calendar_start, max_steps
        self.workers = workers or _workers()
        self.paths: dict[tuple[str, int], np.ndarray | None] = {}
        self.fits = 0

    def _ensure(self, pairs) -> None:
        todo = list({(s.key, int(o)): (s, int(o)) for s, o in pairs if (s.key, int(o)) not in self.paths}.values())
        if not todo:
            return
        tasks = [fit_task(s, o, self.max_steps, self.calendar_start) for s, o in todo]
        if self.workers > 1 and len(tasks) > 8:
            with ProcessPoolExecutor(max_workers=self.workers) as pool:
                results = list(pool.map(fit_path, tasks, chunksize=8))
        else:
            results = [fit_path(t) for t in tasks]
        for (s, o), path in zip(todo, results):
            self.paths[(s.key, o)] = path
        self.fits += len(tasks)

    def rates(self, series_list, origins, horizon: int) -> np.ndarray:
        """Average daily demand over the next `horizon` days for each (series, forecast date)."""
        pairs = list(zip(series_list, origins))
        self._ensure(pairs)
        out = []
        for s, o in pairs:
            path = self.paths[(s.key, int(o))]
            if path is None:  # too little history for Prophet: stockout-aware moving average
                r, _ = s.rate(int(o), 28)
                if np.isnan(r):
                    r, _ = s.rate(int(o), 91)
                out.append(0.0 if np.isnan(r) else float(r))
            else:
                out.append(float(path[:horizon].mean()))
        return np.asarray(out, dtype=float)
