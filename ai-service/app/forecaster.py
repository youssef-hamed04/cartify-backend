"""Train, evaluate and run the demand forecasting models.

One global model per horizon is trained across every product x location series. The target is the
average daily demand over the next H days, measured on in-stock days only, so stockouts are not
learnt as "zero demand". Candidate models are compared on a time-based hold-out: the most recent
forecast origins are the test set, and training samples whose target windows overlap the test
period are purged so the test score is never computed on data the model has seen.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Callable

import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import __version__
from .features import (MIN_HISTORY_DAYS, MIN_TARGET_COVERAGE, FeatureSpace, Series, align, build_calendar,
                       training_origins)

TEST_SHARE = 0.25  # share of the (weekly) forecast origins held out for testing
TREND_THRESHOLD = 0.15  # +/-15 % vs. the recent rate counts as increasing / decreasing
MIN_TRAIN_SAMPLES = 60
MIN_TEST_SAMPLES = 20
RANDOM_STATE = 42


class MovingAverageBaseline:
    """Forecast = stockout-aware average daily demand of the last 28 days (91 days if unavailable)."""

    def __init__(self, idx28: int, idx91: int) -> None:
        self.idx28, self.idx91 = idx28, idx91

    def fit(self, X: np.ndarray, y: np.ndarray) -> "MovingAverageBaseline":
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        r = X[:, self.idx28].copy()
        missing = np.isnan(r)
        r[missing] = X[missing, self.idx91]
        return np.nan_to_num(r, nan=0.0)


class DropAllMissing(BaseEstimator, TransformerMixin):
    """Drops feature columns that are missing for every training sample (e.g. the last-year features
    while a store has less than a year of history); gradient boosting cannot bin an empty column."""

    def fit(self, X: np.ndarray, y=None) -> "DropAllMissing":
        self.keep_ = ~np.all(np.isnan(X), axis=0)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        return X[:, self.keep_]


class SeasonalNaiveBaseline(MovingAverageBaseline):
    """Forecast = last 28 days' rate x last year's change over the same weeks (moving average until
    there is a year of history)."""

    def __init__(self, idx28: int, idx91: int, idx_seasonal: int) -> None:
        super().__init__(idx28, idx91)
        self.idx_seasonal = idx_seasonal

    def predict(self, X: np.ndarray) -> np.ndarray:
        base = super().predict(X)
        sn = X[:, self.idx_seasonal]
        return np.where(np.isnan(sn), base, sn)


@dataclass
class Candidate:
    name: str
    label: str
    factory: Callable[[FeatureSpace], object]


def _candidates() -> list[Candidate]:
    cands = [
        Candidate("moving_average_28d", "Moving average, 28 days (baseline)",
                  lambda fs: MovingAverageBaseline(fs.names.index("rate_28d"), fs.names.index("rate_91d"))),
        Candidate("seasonal_naive", "Seasonal naive, same weeks last year (baseline)",
                  lambda fs: SeasonalNaiveBaseline(fs.names.index("rate_28d"), fs.names.index("rate_91d"),
                                                   fs.names.index("seasonal_naive"))),
        Candidate("linear_regression", "Linear regression (ridge)",
                  lambda fs: make_pipeline(SimpleImputer(strategy="median", keep_empty_features=True),
                                           StandardScaler(), Ridge(alpha=1.0))),
        Candidate("random_forest", "Random forest",
                  lambda fs: make_pipeline(SimpleImputer(strategy="median", keep_empty_features=True),
                                           RandomForestRegressor(n_estimators=150, min_samples_leaf=3, max_features=0.5,
                                                                 n_jobs=-1, random_state=RANDOM_STATE))),
        Candidate("gradient_boosting", "Gradient boosting (histogram, Poisson loss)",
                  lambda fs: make_pipeline(DropAllMissing(),
                                           HistGradientBoostingRegressor(loss="poisson", learning_rate=0.05, max_iter=300,
                                                                         max_leaf_nodes=31, min_samples_leaf=20,
                                                                         l2_regularization=1.0, random_state=RANDOM_STATE))),
    ]
    try:  # optional: evaluated only when xgboost is installed (not a required dependency)
        from xgboost import XGBRegressor  # type: ignore

        cands.append(Candidate("xgboost", "XGBoost (Poisson objective)",
                               lambda fs: make_pipeline(DropAllMissing(), XGBRegressor(
                                   objective="count:poisson", n_estimators=300, learning_rate=0.05, max_depth=6,
                                   subsample=0.8, colsample_bytree=0.8, random_state=RANDOM_STATE))))
    except ImportError:
        pass
    return cands


def metrics(actual: np.ndarray, pred: np.ndarray) -> dict:
    """Errors on total demand per product-location over the horizon (units)."""
    err = pred - actual
    total = float(actual.sum())
    big = actual >= 5  # MAPE is only meaningful where demand is not tiny
    return {
        "mae": round(float(np.abs(err).mean()), 3),
        "rmse": round(float(np.sqrt((err ** 2).mean())), 3),
        "wape": round(float(np.abs(err).sum() / total), 4) if total > 0 else None,
        "mape": round(float((np.abs(err[big]) / actual[big]).mean()), 4) if big.sum() >= 10 else None,
        "bias": round(float(err.sum() / total), 4) if total > 0 else None,
        "samples": int(actual.size),
    }


def build_series(payload_series: list, calendar_start: date, total_days: int) -> list[Series]:
    out = []
    for s in payload_series:
        offset = (s.start - calendar_start).days
        n = len(s.sales)
        sales = align(s.sales, offset, total_days, 0.0)
        avail = align(s.inStock if s.inStock is not None else [1] * n, offset, total_days, 0.0)
        price = align(s.price if s.price is not None else 1.0, offset, total_days, 1.0, backfill=True)
        discount = align(s.discount if s.discount is not None else 0.0, offset, total_days, 0.0, backfill=True)
        latent = align(s.latentDemand, offset, total_days, 0.0) if s.latentDemand is not None else None
        out.append(Series(key=s.key, product_id=s.productId, branch_key=s.branchId or "online",
                          category=s.category or "Uncategorized", sales=sales, avail=avail, price=price,
                          discount=discount, latent=latent))
    return out


def uncensored(series: list[Series]) -> list[Series]:
    """Copy of the series that ignores stockouts (every listed day counts as demand). Ablation only."""
    out = []
    for s in series:
        listed = np.zeros_like(s.avail)
        listed[s.first_listed:] = 1.0
        out.append(Series(key=s.key, product_id=s.product_id, branch_key=s.branch_key, category=s.category,
                          sales=s.sales, avail=listed, price=s.price, discount=s.discount, latent=s.latent))
    return out


def build_samples(series: list[Series], fs: FeatureSpace, horizon: int, calendar_start: date, total_days: int):
    X, y, origins, keys = [], [], [], []
    for o in training_origins(total_days, horizon):
        for s in series:
            if o < s.first_listed + 27:  # needs four weeks on sale before it can be a training sample
                continue
            target, cov = s.future_rate(o, horizon)
            if cov < MIN_TARGET_COVERAGE or np.isnan(target):
                continue
            X.append(fs.row(s, o, horizon, calendar_start))
            y.append(target)
            origins.append(o)
            keys.append(s.key)
    return (np.asarray(X, dtype=float), np.asarray(y, dtype=float), np.asarray(origins), keys)


def split(origins: np.ndarray, horizon: int):
    """Time-based split with purging: train targets must end before the first test origin."""
    uniq = np.unique(origins)
    if uniq.size < 2:
        return None
    n_test = max(1, int(round(uniq.size * TEST_SHARE)))
    test_first = uniq[-n_test]
    train = origins + horizon <= test_first
    test = origins >= test_first
    return train, test, int(test_first)


def feature_importance(model, names: list[str]) -> list[dict]:
    est = model.steps[-1][1] if hasattr(model, "steps") else model
    values = None
    if hasattr(est, "feature_importances_"):
        values = np.asarray(est.feature_importances_, dtype=float)
    elif hasattr(est, "coef_"):
        values = np.abs(np.asarray(est.coef_, dtype=float))
    if values is None or values.size != len(names) or values.sum() <= 0:
        return []
    values = values / values.sum()
    order = np.argsort(values)[::-1][:8]
    return [{"feature": names[i], "importance": round(float(values[i]), 4)} for i in order]


def _trend(pred_rate: float, recent: float) -> tuple[str, float | None]:
    if np.isnan(recent):
        return "unknown", None
    pct = (pred_rate - recent) / max(recent, 0.05)
    if pct >= TREND_THRESHOLD:
        return "increasing", round(float(pct), 4)
    if pct <= -TREND_THRESHOLD:
        return "decreasing", round(float(pct), 4)
    return "stable", round(float(pct), 4)


def forecast_horizon(series: list[Series], fs: FeatureSpace, horizon: int, calendar_start: date,
                     total_days: int) -> dict:
    cands = _candidates()
    X, y, origins, _ = build_samples(series, fs, horizon, calendar_start, total_days)
    result: dict = {"horizonDays": horizon, "warnings": []}
    parts = split(origins, horizon) if len(y) else None

    evaluated, chosen, test_info, ratios = [], None, None, None
    if parts is not None and parts[0].sum() >= MIN_TRAIN_SAMPLES and parts[1].sum() >= MIN_TEST_SAMPLES:
        train, test, test_first = parts
        actual = y[test] * horizon
        for c in cands:
            model = c.factory(fs)
            model.fit(X[train], y[train])
            pred_rate = np.clip(model.predict(X[test]), 0, None)
            m = metrics(actual, pred_rate * horizon)
            evaluated.append({"name": c.name, "label": c.label, **m, "_pred": pred_rate})
        best = min(evaluated, key=lambda e: e["mae"])
        chosen = next(c for c in cands if c.name == best["name"])
        p = best["_pred"]
        ok = p > 0.02
        if ok.sum() >= 10:
            r = y[test][ok] / p[ok]
            ratios = (float(min(np.quantile(r, 0.1), 1.0)), float(max(np.quantile(r, 0.9), 1.0)))
        test_info = {
            "from": (calendar_start + timedelta(days=test_first + 1)).isoformat(),
            "to": (calendar_start + timedelta(days=total_days - 1)).isoformat(),
            "trainSamples": int(train.sum()),
            "testSamples": int(test.sum()),
            "trainOrigins": int(np.unique(origins[train]).size),
            "testOrigins": int(np.unique(origins[test]).size),
        }
        result["status"] = "ok"
    else:
        chosen = cands[0]
        result["status"] = "baseline_only"
        result["warnings"].append(
            f"Not enough history for a {horizon}-day model evaluation (needs at least "
            f"{MIN_HISTORY_DAYS + horizon} days and enough in-stock weeks). The 28-day moving average is used "
            "and no accuracy is claimed.")

    model = chosen.factory(fs)
    if len(y):
        model.fit(X, y)  # refit the chosen model on every sample, test period included

    last = total_days - 1
    rows, keys_order = [], []
    for s in series:
        rows.append(fs.row(s, last, horizon, calendar_start))
        keys_order.append(s)
    P = np.asarray(rows, dtype=float)
    pred_rates = np.clip(model.predict(P), 0, None) if len(rows) else np.array([])
    q10, q90 = ratios if ratios else (0.6, 1.5)
    if not ratios:
        result["warnings"].append("Prediction interval uses a default +/- range (not enough test data to calibrate it).")

    forecasts = []
    for s, rate in zip(keys_order, pred_rates):
        listed_days = max(0, last - s.first_listed + 1)
        if listed_days == 0:
            rate = 0.0
        recent, _ = s.rate(last, 28)
        if np.isnan(recent):
            recent, _ = s.rate(last, 91)
        trend, trend_pct = _trend(float(rate), recent)
        lo28 = max(last - 27, s.first_listed)
        stockout_days = int((1 - s.avail[lo28 : last + 1]).sum()) if listed_days else 0
        in_stock_days = int(s.ca[last + 1] - s.ca[s.first_listed]) if listed_days else 0
        total = float(rate) * horizon
        forecasts.append({
            "key": s.key,
            "productId": s.product_id,
            "branchId": None if s.branch_key == "online" else s.branch_key,
            "predicted": round(total, 2),
            "low": round(total * q10, 2),
            "high": round(total * q90, 2),
            "dailyRate": round(float(rate), 4),
            "recentDailyRate": None if np.isnan(recent) else round(float(recent), 4),
            "trend": trend,
            "trendPct": trend_pct,
            "stockoutDaysLast28": stockout_days,
            "historyDays": listed_days,
            "lowConfidence": listed_days < MIN_HISTORY_DAYS or in_stock_days < 28,
        })

    result.update({
        "selectedModel": chosen.name,
        "selectedModelLabel": chosen.label,
        "selectionRule": "lowest MAE on the time-based hold-out" if evaluated else "fallback (no evaluation possible)",
        "candidates": [{k: v for k, v in e.items() if k != "_pred"} for e in evaluated],
        "test": test_info,
        "interval": {"lowRatio": round(q10, 4), "highRatio": round(q90, 4), "coverage": "10th-90th percentile"},
        "featureImportance": feature_importance(model, fs.names) if len(y) else [],
        "forecasts": forecasts,
    })
    return result


def run_forecast(req) -> dict:
    t0 = time.time()
    calendar_start = min(s.start for s in req.series)
    total_days = build_calendar(calendar_start, req.asOf)
    series = build_series(req.series, calendar_start, total_days)
    fs = FeatureSpace(categories=sorted({s.category for s in series}), branches=sorted({s.branch_key for s in series}))
    horizons = [forecast_horizon(series, fs, h, calendar_start, total_days) for h in req.horizons]
    return {
        "serviceVersion": __version__,
        "asOf": req.asOf.isoformat(),
        "calendarStart": calendar_start.isoformat(),
        "historyDays": total_days,
        "seriesCount": len(series),
        "features": fs.names,
        "target": "average daily demand over the horizon, measured on in-stock days only",
        "minTargetCoverage": MIN_TARGET_COVERAGE,
        "horizons": horizons,
        "durationMs": int((time.time() - t0) * 1000),
    }
