"""Feature engineering for stockout-aware demand forecasting.

Every series is one product at one location (a branch, or the online store) with one value per day:
units sold, whether the item was available, the selling price and the discount.

Days when the item was out of stock are *censored*: sales were 0 (or cut short) because there was
nothing to sell, not because nobody wanted it. All demand rates below are therefore computed over
in-stock days only, and training targets skip windows that were mostly out of stock.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

RATE_WINDOWS = (7, 14, 28, 56, 91)
MIN_HISTORY_DAYS = 56  # history needed before the first forecast origin
ORIGIN_STEP_DAYS = 7  # one training sample per series per week
MIN_TARGET_COVERAGE = 0.5  # a target window must be at least 50 % in stock to be used


@dataclass
class Series:
    key: str
    product_id: str
    branch_key: str  # branch id, or "online"
    category: str
    sales: np.ndarray  # units sold per day (aligned to the global calendar)
    avail: np.ndarray  # 1.0 = in stock that day, 0.0 = out of stock / not listed yet
    price: np.ndarray
    discount: np.ndarray
    latent: np.ndarray | None = None  # true demand, synthetic data only (evaluation)
    # cumulative sums for O(1) window rates
    cs: np.ndarray = field(init=False)
    ca: np.ndarray = field(init=False)
    first_listed: int = field(init=False)

    def __post_init__(self) -> None:
        self.cs = np.concatenate([[0.0], np.cumsum(self.sales * self.avail)])
        self.ca = np.concatenate([[0.0], np.cumsum(self.avail)])
        listed = np.flatnonzero(self.avail > 0)
        self.first_listed = int(listed[0]) if listed.size else len(self.sales)

    def rate(self, end: int, k: int) -> tuple[float, float]:
        """Mean daily demand over the k days ending at `end` (inclusive), in-stock days only.

        Returns (rate, coverage). rate is NaN when the item was never in stock in the window.
        """
        lo = max(0, end - k + 1)
        n_avail = self.ca[end + 1] - self.ca[lo]
        if n_avail <= 0:
            return float("nan"), 0.0
        return float((self.cs[end + 1] - self.cs[lo]) / n_avail), float(n_avail / (end - lo + 1))

    def future_rate(self, origin: int, horizon: int) -> tuple[float, float]:
        """In-stock demand rate over the `horizon` days after `origin` (the training target)."""
        hi = origin + horizon
        n_avail = self.ca[hi + 1] - self.ca[origin + 1]
        if n_avail <= 0:
            return float("nan"), 0.0
        return float((self.cs[hi + 1] - self.cs[origin + 1]) / n_avail), float(n_avail / horizon)

    def latent_total(self, origin: int, horizon: int) -> float:
        assert self.latent is not None
        return float(self.latent[origin + 1 : origin + horizon + 1].sum())


def build_calendar(start: date, as_of: date) -> int:
    return (as_of - start).days + 1


def align(values: list[float] | float | None, offset: int, total: int, fill: float, backfill: bool = False) -> np.ndarray:
    """Place a series that starts `offset` days into the global calendar onto that calendar.

    Days before the series starts get `fill`, or the first known value when `backfill` is set
    (used for prices: those days are unavailable anyway, the value only keeps features finite).
    """
    out = np.full(total, fill, dtype=float)
    if values is None:
        return out
    if isinstance(values, (int, float)):
        out[:] = float(values)
        return out
    arr = np.asarray(values, dtype=float)
    out[offset : offset + arr.size] = arr
    if backfill and offset > 0 and arr.size:
        out[:offset] = arr[0]
    return out


def weekly_slope(s: Series, end: int, weeks: int = 8) -> float:
    """Slope of the weekly in-stock demand rate over the last `weeks` weeks, relative to its mean."""
    rates = []
    for w in range(weeks, 0, -1):
        r, cov = s.rate(end - (w - 1) * 7, 7)
        rates.append(r if cov > 0 else np.nan)
    y = np.asarray(rates)
    ok = ~np.isnan(y)
    if ok.sum() < 4:
        return float("nan")
    x = np.arange(weeks, dtype=float)[ok]
    y = y[ok]
    mean = y.mean()
    if mean <= 1e-6:
        return 0.0
    slope = np.polyfit(x, y, 1)[0]
    return float(slope / mean)


def last_year(s: Series, origin: int, horizon: int) -> tuple[float, float]:
    """Same period one year earlier: the demand rate over the target window, and how much demand
    changed from the 28 days before it to the window itself (the yearly seasonal swing).
    NaN until the series has more than a year of in-stock history."""
    ly = origin - 364  # 52 weeks back keeps the weekday mix identical
    if ly - 27 < s.first_listed:
        return float("nan"), float("nan")
    before, cov_b = s.rate(ly, 28)
    during, cov_d = s.future_rate(ly, horizon)
    if cov_d < MIN_TARGET_COVERAGE or np.isnan(during):
        return float("nan"), float("nan")
    ratio = during / before if (cov_b > 0 and before > 0.05) else float("nan")
    return float(during), float(np.clip(ratio, 0.1, 10)) if not np.isnan(ratio) else float("nan")


@dataclass
class FeatureSpace:
    categories: list[str]
    branches: list[str]

    @property
    def names(self) -> list[str]:
        base = [f"rate_{k}d" for k in RATE_WINDOWS]
        base += ["in_stock_share_28d", "in_stock_share_91d", "trend_28_vs_91", "weekly_slope_8w",
                 "log_price", "discount_pct", "price_change_28d", "target_month_sin", "target_month_cos",
                 "days_listed", "last_year_target_rate", "last_year_seasonal_ratio", "seasonal_naive"]
        base += [f"category={c}" for c in self.categories]
        base += [f"location={b}" for b in self.branches]
        return base

    def row(self, s: Series, origin: int, horizon: int, calendar_start: date) -> list[float]:
        rates, covs = [], {}
        for k in RATE_WINDOWS:
            r, cov = s.rate(origin, k)
            rates.append(r)
            covs[k] = cov
        r28, r91 = rates[2], rates[4]
        trend = r28 / r91 if (not np.isnan(r28) and not np.isnan(r91) and r91 > 1e-6) else float("nan")
        price_now = max(s.price[origin], 0.01)
        price_then = max(s.price[max(0, origin - 28)], 0.01)
        mid = calendar_start + timedelta(days=origin + horizon / 2)
        angle = 2 * np.pi * (mid.month - 1 + (mid.day - 1) / 31) / 12
        days_listed = min(max(origin - s.first_listed, 0), 365) / 365
        ly_rate, ly_ratio = last_year(s, origin, horizon)
        seasonal_naive = r28 * ly_ratio if not (np.isnan(r28) or np.isnan(ly_ratio)) else float("nan")
        row = rates + [covs[28], covs[91], trend, weekly_slope(s, origin), float(np.log(price_now)),
                       float(s.discount[origin]), float(price_now / price_then - 1), float(np.sin(angle)),
                       float(np.cos(angle)), float(days_listed), ly_rate, ly_ratio, seasonal_naive]
        row += [1.0 if s.category == c else 0.0 for c in self.categories]
        row += [1.0 if s.branch_key == b else 0.0 for b in self.branches]
        return row


def training_origins(total_days: int, horizon: int) -> list[int]:
    """Weekly forecast origins whose full target window lies inside the history."""
    last = total_days - 1 - horizon
    first = MIN_HISTORY_DAYS - 1
    if last < first:
        return []
    origins = list(range(last, first - 1, -ORIGIN_STEP_DAYS))
    return sorted(origins)
