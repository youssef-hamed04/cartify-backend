"""Request validation for the forecasting API. Every list is length-checked against its series."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_DAYS = 3 * 366
MAX_SERIES = 5000

NonNeg = Annotated[float, Field(ge=0)]
PriceList = list[Annotated[float, Field(ge=0)]]


class SeriesIn(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    productId: str = Field(min_length=1, max_length=64)
    branchId: Optional[str] = Field(default=None, max_length=64)  # null = online store
    category: str = Field(default="Uncategorized", max_length=80)
    start: date
    sales: list[NonNeg] = Field(min_length=1, max_length=MAX_DAYS)
    inStock: Optional[list[Annotated[int, Field(ge=0, le=1)]]] = None
    price: Optional[Union[NonNeg, PriceList]] = None
    discount: Optional[Union[Annotated[float, Field(ge=0, le=100)], list[Annotated[float, Field(ge=0, le=100)]]]] = None
    latentDemand: Optional[list[NonNeg]] = None  # synthetic datasets only, used by the offline evaluation

    @model_validator(mode="after")
    def same_lengths(self):
        n = len(self.sales)
        for name in ("inStock", "price", "discount", "latentDemand"):
            v = getattr(self, name)
            if isinstance(v, list) and len(v) != n:
                raise ValueError(f"{name} must have {n} values like sales (series {self.key})")
        return self


class ForecastRequest(BaseModel):
    asOf: date
    horizons: list[Annotated[int, Field(ge=1, le=180)]] = Field(min_length=1, max_length=3)
    series: list[SeriesIn] = Field(min_length=1, max_length=MAX_SERIES)

    @field_validator("horizons")
    @classmethod
    def unique_horizons(cls, v: list[int]) -> list[int]:
        return sorted(set(v))

    @model_validator(mode="after")
    def series_end_at_as_of(self):
        keys = set()
        for s in self.series:
            if s.key in keys:
                raise ValueError(f"duplicate series key {s.key}")
            keys.add(s.key)
            end = s.start + timedelta(days=len(s.sales) - 1)
            if end != self.asOf:
                raise ValueError(f"series {s.key} ends on {end}, expected asOf {self.asOf}")
        return self
