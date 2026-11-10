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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--markdown", help="also write the report to this Markdown file")
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
        lines.append("")

    report = "\n".join(lines)
    print(report)
    if args.markdown:
        Path(args.markdown).write_text(report)


if __name__ == "__main__":
    main()
