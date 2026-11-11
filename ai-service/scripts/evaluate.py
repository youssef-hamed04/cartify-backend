"""Offline evaluation of the demand forecasting models.

    node scripts/exportForecastDataset.js dataset.json            (from cartify-backend/)
    ai-service/.venv/bin/python ai-service/scripts/evaluate.py dataset.json [--markdown report.md]

Prints, for every horizon, the time-based hold-out scores of each candidate model (the same
procedure the API uses to pick a model). When the dataset carries simulated true demand (synthetic
demo data only), it also measures the stockout handling: the chosen model trained the stockout-aware
way vs. trained on raw sales where sold-out days count as zero demand, both scored against true demand.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import FeatureSpace  # noqa: E402
from app.forecaster import (_candidates, build_samples, build_series, metrics, run_forecast, split,  # noqa: E402
                            uncensored)
from app.schemas import ForecastRequest  # noqa: E402


def stockout_ablation(series, fs, horizon, start, total, model_name):
    cand = next(c for c in _candidates() if c.name == model_name)
    by_key = {s.key: s for s in series}
    out = {}
    for label, data in (("stockout_aware", series), ("naive_zero_demand", uncensored(series))):
        X, y, origins, _ = build_samples(data, fs, horizon, start, total)
        parts = split(origins, horizon)
        if parts is None:
            return None
        train, _, test_first = parts
        model = cand.factory(fs)
        model.fit(X[train], y[train])
        rows, actual = [], []
        for o in sorted(set(int(v) for v in origins if v >= test_first)):
            for s in data:
                if o < s.first_listed + 27:
                    continue
                rows.append(fs.row(s, o, horizon, start))
                actual.append(by_key[s.key].latent_total(o, horizon))
        pred = np.clip(model.predict(np.asarray(rows, dtype=float)), 0, None) * horizon
        out[label] = metrics(np.asarray(actual), pred)
    return out


def _prophet_one(task):
    """Fit Prophet on one series up to `origin` (sold-out days left out) and return the mean daily
    forecast for the next `horizon` days. Top-level so it can run in a worker process."""
    import logging
    import pandas as pd
    from prophet import Prophet
    logging.getLogger("cmdstanpy").setLevel(logging.ERROR)
    logging.getLogger("prophet").setLevel(logging.ERROR)
    start, days, sales, origin, horizon = task
    df = pd.DataFrame({"ds": pd.to_datetime(start) + pd.to_timedelta(days, unit="D"), "y": sales})
    m = Prophet(yearly_seasonality=True, weekly_seasonality=True, daily_seasonality=False)
    m.fit(df)
    fut = pd.DataFrame({"ds": pd.to_datetime(start) + pd.to_timedelta(np.arange(origin + 1, origin + horizon + 1), unit="D")})
    return max(0.0, float(m.predict(fut)["yhat"].clip(lower=0).mean()))


def weekly_rates(s, origin: int, weeks: int = 104) -> np.ndarray:
    """In-stock demand rate (units/day) for each of the last `weeks` weeks before `origin`.
    Sold-out weeks are filled from neighbouring weeks instead of counting as zero demand."""
    vals = []
    for w in range(weeks, 0, -1):
        end = origin - (w - 1) * 7
        if end - 6 < s.first_listed:
            continue
        r, cov = s.rate(end, 7)
        vals.append(r if cov > 0 else np.nan)
    y = np.asarray(vals, dtype=float)
    if y.size and np.isnan(y).any():
        idx = np.arange(y.size)
        ok = ~np.isnan(y)
        y = np.interp(idx, idx[ok], y[ok]) if ok.any() else np.zeros_like(y)
    return y


def classical_comparison(series, fs, horizon, start, total, ml_name, max_prophet, seed=0, workers=1):
    """Score per-series time-series models (statsmodels exponential smoothing, Prophet) on exactly
    the same hold-out samples as the ML models, so the numbers are comparable."""
    import warnings
    warnings.filterwarnings("ignore")
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    X, y, origins, keys = build_samples(series, fs, horizon, start, total)
    train, test, _ = split(origins, horizon)
    idx = np.flatnonzero(test)
    by_key = {s.key: s for s in series}
    cand = {c.name: c for c in _candidates()}
    ml = cand[ml_name].factory(fs)
    ml.fit(X[train], y[train])
    ml_pred = np.clip(ml.predict(X[idx]), 0, None)
    ma_pred = cand["moving_average_28d"].factory(fs).predict(X[idx])

    weeks_ahead = max(1, int(np.ceil(horizon / 7)))
    ets_pred = []
    for i in idx:
        hist = weekly_rates(by_key[keys[i]], int(origins[i]))
        if hist.size < 8:
            ets_pred.append(ma_pred[len(ets_pred)])
            continue
        fit = ExponentialSmoothing(hist, trend="add", damped_trend=True, initialization_method="estimated").fit()
        ets_pred.append(max(0.0, float(np.mean(fit.forecast(weeks_ahead)))))
    out = {"samples": int(idx.size), "models": {
        ml_name: metrics(y[idx] * horizon, ml_pred * horizon),
        "moving_average_28d": metrics(y[idx] * horizon, ma_pred * horizon),
        "statsmodels_exponential_smoothing": metrics(y[idx] * horizon, np.asarray(ets_pred) * horizon),
    }}

    if max_prophet:
        from concurrent.futures import ProcessPoolExecutor
        rng = np.random.default_rng(seed)
        size = idx.size if max_prophet < 0 else min(max_prophet, idx.size)
        sub = np.sort(rng.choice(np.arange(idx.size), size=size, replace=False))
        tasks = []
        for j in sub:
            s, o = by_key[keys[idx[j]]], int(origins[idx[j]])
            days = np.arange(s.first_listed, o + 1)
            keep = s.avail[days] > 0  # sold-out days are left out, not counted as zero demand
            tasks.append((start, days[keep], s.sales[days][keep], o, horizon))
        with ProcessPoolExecutor(max_workers=workers) as pool:
            p_pred = list(pool.map(_prophet_one, tasks, chunksize=8))
        yy = y[idx][sub] * horizon
        out["prophet_subset"] = {"samples": int(sub.size), "models": {
            "prophet": metrics(yy, np.asarray(p_pred) * horizon),
            "average_ml_prophet": metrics(yy, (ml_pred[sub] + np.asarray(p_pred)) / 2 * horizon),
            ml_name: metrics(yy, ml_pred[sub] * horizon),
            "statsmodels_exponential_smoothing": metrics(yy, np.asarray(ets_pred)[sub] * horizon),
            "moving_average_28d": metrics(yy, ma_pred[sub] * horizon),
        }}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--markdown", help="also write the report to this Markdown file")
    ap.add_argument("--classical", action="store_true", help="also score statsmodels exponential smoothing (pip install -r requirements-eval.txt)")
    ap.add_argument("--prophet", type=int, default=0, metavar="N", help="also score Prophet on N random hold-out samples, or -1 for all (slow: one fit per sample)")
    ap.add_argument("--prophet-horizons", type=int, nargs="*", metavar="H", help="only run Prophet for these horizons (default: all)")
    ap.add_argument("--workers", type=int, default=1, help="parallel processes for the Prophet fits")
    args = ap.parse_args()
    data = json.loads(Path(args.dataset).read_text())
    req = ForecastRequest(asOf=data["asOf"], horizons=data.get("horizons", [7, 30, 90]), series=data["series"])
    result = run_forecast(req)

    lines = [f"# Demand forecasting evaluation", "",
             f"- Data source: **{data.get('dataSource', 'unknown')}**"
             + (" (SYNTHETIC DEMONSTRATION DATA — not real sales)" if data.get("dataSource") == "synthetic_demo" else ""),
             f"- History: {result['historyDays']} days up to {result['asOf']}, {result['seriesCount']} product x location series",
             f"- Target: {result['target']}",
             "- Split: time-based hold-out (last 25 % of weekly forecast origins), training windows purged so they end before the test period",
             "- Errors are in units of total demand per product-location over the horizon", ""]
    has_latent = any(s.latentDemand is not None for s in req.series)
    start = min(s.start for s in req.series)
    total = result["historyDays"]
    series = build_series(req.series, start, total)
    fs = FeatureSpace(categories=sorted({s.category for s in series}), branches=sorted({s.branch_key for s in series}))

    for h in result["horizons"]:
        lines += [f"## {h['horizonDays']}-day horizon — selected: {h['selectedModelLabel']}", ""]
        if h["test"]:
            t = h["test"]
            lines.append(f"Test period {t['from']} → {t['to']} · {t['trainSamples']} training / {t['testSamples']} test samples")
            lines.append("")
        lines += ["| Model | MAE | RMSE | WAPE | MAPE (demand ≥ 5) | Bias |", "|---|---:|---:|---:|---:|---:|"]
        base = next((c for c in h["candidates"] if c["name"] == "moving_average_28d"), None)
        for c in sorted(h["candidates"], key=lambda c: c["mae"]):
            mark = " ✅" if c["name"] == h["selectedModel"] else ""
            pct = lambda v: "—" if v is None else f"{100 * v:.1f} %"
            lines.append(f"| {c['label']}{mark} | {c['mae']:.2f} | {c['rmse']:.2f} | {pct(c['wape'])} | {pct(c['mape'])} | {pct(c['bias'])} |")
        if base and h["candidates"]:
            best = min(h["candidates"], key=lambda c: c["mae"])
            lines += ["", f"Improvement of the selected model over the 28-day moving average: "
                          f"{100 * (1 - best['mae'] / base['mae']):.1f} % lower MAE."]
        if h["featureImportance"]:
            lines += ["", "Top features: " + ", ".join(f"{f['feature']} ({f['importance']:.2f})" for f in h["featureImportance"][:6])]
        for w in h["warnings"]:
            lines += ["", f"> ⚠️ {w}"]
        if has_latent and h["status"] == "ok":
            ab = stockout_ablation(series, fs, h["horizonDays"], start, total, h["selectedModel"]
                                   if h["selectedModel"] not in ("moving_average_28d", "seasonal_naive") else "gradient_boosting")
            if ab:
                a, n = ab["stockout_aware"], ab["naive_zero_demand"]
                lines += ["", "Stockout handling, scored against the simulated **true** demand (incl. demand lost to stockouts):", "",
                          "| Training data | MAE | Bias |", "|---|---:|---:|",
                          f"| Stockout-aware (in-stock days only) | {a['mae']:.2f} | {100 * a['bias']:.1f} % |",
                          f"| Naive (sold-out days = zero demand) | {n['mae']:.2f} | {100 * n['bias']:.1f} % |"]
        if (args.classical or args.prophet) and h["status"] == "ok":
            ml_name = h["selectedModel"] if h["selectedModel"] not in ("moving_average_28d", "seasonal_naive") else "gradient_boosting"
            n_prophet = args.prophet if not args.prophet_horizons or h["horizonDays"] in args.prophet_horizons else 0
            cc = classical_comparison(series, fs, h["horizonDays"], start, total, ml_name, n_prophet, workers=args.workers)
            label = {c.name: c.label for c in _candidates()}
            label.update({"statsmodels_exponential_smoothing": "Exponential smoothing, damped trend (statsmodels, per series)",
                     "prophet": "Prophet (per series, yearly + weekly seasonality)",
                     "average_ml_prophet": f"Average of {label.get(ml_name, ml_name)} and Prophet"})
            for title, block in (("Classical time-series models on the same hold-out samples", cc),
                                 ("Prophet on " + ("all" if cc.get("prophet_subset", {}).get("samples") == cc["samples"] else "a random subset of the") + " hold-out samples", cc.get("prophet_subset"))):
                if not block:
                    continue
                lines += ["", f"{title} ({block['samples']} samples):", "", "| Model | MAE | RMSE | WAPE |", "|---|---:|---:|---:|"]
                for name, m in sorted(block["models"].items(), key=lambda kv: kv[1]["mae"]):
                    lines.append(f"| {label.get(name, name.replace('_', ' ').capitalize())} | {m['mae']:.2f} | {m['rmse']:.2f} | {100 * (m['wape'] or 0):.1f} % |")
        lines.append("")

    report = "\n".join(lines)
    print(report)
    if args.markdown:
        Path(args.markdown).write_text(report)


if __name__ == "__main__":
    main()
