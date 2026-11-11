"""Unit tests for the forecasting pipeline. Run: .venv/bin/python -m unittest discover -s tests"""

import unittest
from datetime import date, timedelta

import numpy as np

from app.features import Series, training_origins
from app.forecaster import run_forecast, split
from app.schemas import ForecastRequest


def make_request(days=300, horizon=30, stockout=False, seed=0):
    rng = np.random.default_rng(seed)
    as_of = date(2026, 6, 30)
    start = as_of - timedelta(days=days - 1)
    series = []
    for p in range(12):
        for b in ("b1", "b2", None):
            base = 1 + p % 4
            t = np.arange(days)
            lam = base * (1 + 0.3 * np.sin(2 * np.pi * t / 7)) * (1 + 0.002 * t * (1 if p % 2 else -0.3))
            sales = rng.poisson(np.clip(lam, 0.05, None)).astype(float)
            in_stock = np.ones(days, dtype=int)
            if stockout and p == 0:
                in_stock[150:180] = 0
                sales[150:180] = 0
            series.append({"key": f"p{p}:{b or 'online'}", "productId": f"p{p}", "branchId": b,
                           "category": "A" if p < 6 else "B", "start": start.isoformat(),
                           "sales": sales.tolist(), "inStock": in_stock.tolist(), "price": 10.0 + p})
    return ForecastRequest(asOf=as_of.isoformat(), horizons=[horizon], series=series)


class FeatureTests(unittest.TestCase):
    def test_rate_ignores_stockout_days(self):
        sales = np.array([4, 4, 0, 0, 4, 4], dtype=float)
        avail = np.array([1, 1, 0, 0, 1, 1], dtype=float)
        s = Series("k", "p", "online", "A", sales, avail, np.ones(6), np.zeros(6))
        rate, cov = s.rate(5, 6)
        self.assertAlmostEqual(rate, 4.0)  # the zeros on stockout days are not counted as demand
        self.assertAlmostEqual(cov, 4 / 6)

    def test_no_window_overlap_between_train_and_test(self):
        origins = np.array(training_origins(300, 30))
        train, test, test_first = split(origins, 30)
        self.assertTrue(np.all(origins[train] + 30 <= test_first))
        self.assertTrue(np.all(origins[test] >= test_first))


class ForecastTests(unittest.TestCase):
    def test_forecast_shapes_and_bounds(self):
        out = run_forecast(make_request())
        h = out["horizons"][0]
        self.assertEqual(h["status"], "ok")
        self.assertEqual(len(h["forecasts"]), 36)
        self.assertGreaterEqual(len(h["candidates"]), 4)
        for f in h["forecasts"]:
            self.assertGreaterEqual(f["predicted"], 0)
            self.assertLessEqual(f["low"], f["predicted"] + 1e-9)
            self.assertGreaterEqual(f["high"], f["predicted"] - 1e-9)
        names = {c["name"] for c in h["candidates"]}
        self.assertIn(h["selectedModel"], names)
        ml = [c for c in h["candidates"] if not c.get("scoredOn")]
        best_ml = min(ml, key=lambda c: c["mae"])
        extra = [c for c in h["candidates"] if c.get("scoredOn")]  # Prophet and the ML + Prophet average
        if extra:  # scored on a subset of the test samples, compared with the best ML model on the same ones
            self.assertEqual({c["name"] for c in extra}, {"prophet", "ml_prophet_average"})
            self.assertTrue(all(c["scoredOn"]["comparedWith"] == best_ml["name"] for c in extra))
            contender = min(extra, key=lambda c: c["mae"])
            wins = contender["mae"] < contender["scoredOn"]["comparedMae"]
            self.assertEqual(h["selectedModel"], contender["name"] if wins else best_ml["name"])
        else:
            self.assertEqual(h["selectedModel"], best_ml["name"])

    def test_prophet_candidate_can_be_switched_off(self):
        import os
        from app import prophet_model
        if not prophet_model.enabled():
            self.skipTest("prophet not installed")
        out = run_forecast(make_request())
        self.assertTrue(out["prophet"]["used"])
        self.assertIn("prophet", {c["name"] for c in out["horizons"][0]["candidates"]})
        os.environ["FORECAST_PROPHET"] = "off"
        try:
            out = run_forecast(make_request())
        finally:
            del os.environ["FORECAST_PROPHET"]
        self.assertFalse(out["prophet"]["used"])
        self.assertNotIn("prophet", {c["name"] for c in out["horizons"][0]["candidates"]})

    def test_short_history_falls_back_to_baseline(self):
        out = run_forecast(make_request(days=70, horizon=30))
        self.assertEqual(out["horizons"][0]["status"], "baseline_only")
        self.assertTrue(out["horizons"][0]["warnings"])

    def test_stockout_counted(self):
        out = run_forecast(make_request(stockout=True))
        self.assertEqual(out["horizons"][0]["forecasts"][0]["stockoutDaysLast28"], 0)

    def test_rejects_misaligned_series(self):
        with self.assertRaises(ValueError):
            ForecastRequest(asOf="2026-06-30", horizons=[7], series=[{
                "key": "a", "productId": "a", "start": "2026-06-01", "sales": [1, 2, 3]}])


if __name__ == "__main__":
    unittest.main()
