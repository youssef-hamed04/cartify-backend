"""HTTP API of the Cartify AI service. Only the Node backend calls it; it never touches the database."""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException

from . import __version__
from .forecaster import _candidates, run_forecast
from .schemas import ForecastRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cartify-ai")

SERVICE_KEY = os.environ.get("AI_SERVICE_KEY", "")
if not SERVICE_KEY:
    log.warning("AI_SERVICE_KEY is not set: the service accepts any caller. Bind it to 127.0.0.1 only.")

app = FastAPI(title="Cartify AI Service", version=__version__,
              description="Demand forecasting for the Cartify backend (stockout-aware, time-based evaluation).")


def require_key(x_ai_service_key: str = Header(default="")) -> None:
    if SERVICE_KEY and not hmac.compare_digest(x_ai_service_key.encode(), SERVICE_KEY.encode()):
        raise HTTPException(status_code=401, detail="Invalid or missing X-AI-Service-Key")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": __version__, "models": [c.name for c in _candidates()]}


@app.post("/forecast", dependencies=[Depends(require_key)])
def forecast(req: ForecastRequest) -> dict:
    log.info("forecast: %d series, horizons %s, as of %s", len(req.series), req.horizons, req.asOf)
    try:
        out = run_forecast(req)
    except Exception as exc:  # report a clean error to the backend, keep the trace in the service log
        log.exception("forecast failed")
        raise HTTPException(status_code=500, detail=f"Forecast failed: {type(exc).__name__}") from exc
    for h in out["horizons"]:
        log.info("  %sd -> %s (%s), status %s", h["horizonDays"], h["selectedModel"],
                 next((f"MAE {c['mae']}" for c in h["candidates"] if c["name"] == h["selectedModel"]), "no eval"),
                 h["status"])
    log.info("forecast done in %d ms", out["durationMs"])
    return out
