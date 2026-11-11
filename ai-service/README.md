# Cartify AI Service — demand forecasting

A small Python service that trains and runs Cartify's demand forecasting models. The Node backend
stays the main application: it reads the sales history from MongoDB, sends it here, and stores the
predictions. **This service has no database access** and keeps no data between requests.

```
Node backend (MongoDB)  ──POST /forecast (daily sales per product × location)──▶  ai-service (scikit-learn, XGBoost)
                        ◀── predictions per horizon + model evaluation ─────────
```

## Setup

Python 3.11+ is required (tested with 3.13).

```bash
cd ai-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip install -r requirements.txt
```

Dependencies (pinned in `requirements.txt`, all free and open source): `scikit-learn`, `xgboost` and
`numpy` for the models, `fastapi`, `uvicorn` and `pydantic` for the HTTP API with request
validation. No paid service or API key is involved; everything runs on your machine.

For the offline model comparison only (not needed to run the service):
`.venv/bin/pip install -r requirements-eval.txt` adds `statsmodels`, `pandas` and `prophet`.

## Run

```bash
cd ai-service
export AI_SERVICE_KEY=change-me-long-random-string   # same value as AI_SERVICE_KEY in the backend .env
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

- `GET /health` — status and candidate models.
- `POST /forecast` — requires the `X-AI-Service-Key` header when `AI_SERVICE_KEY` is set.
  Interactive docs: http://127.0.0.1:8001/docs

Keep it on `127.0.0.1` (or a private network). Only the backend should call it. The backend finds it
through `AI_SERVICE_URL` (default `http://127.0.0.1:8001`). If the service is down, the backend keeps
serving the last saved forecast and the admin page shows how to start it.

## How the model works

- **Unit of prediction:** one product at one location (a branch, or the online store).
- **Target:** average daily demand over the next *H* days (7, 30 or 90), measured on **in-stock days
  only**. A day that ends sold out is censored: its zero sales are not treated as zero demand, and a
  target window that is less than 50 % in stock is not used for training.
- **Features (per forecast date):** stockout-aware demand rates over 7/14/28/56/91 days, share of
  in-stock days, 28-vs-91-day trend, 8-week slope, price, discount and price change, month of the
  target window, time on sale, the same weeks last year (rate and seasonal swing), category and
  location.
- **Candidates:** 28-day moving average and same-weeks-last-year seasonal naive (baselines),
  ridge linear regression, random forest, histogram gradient boosting with a Poisson loss
  (scikit-learn) and XGBoost with a Poisson objective. One global model is trained per horizon
  across all products and locations, so new or slow products borrow strength from similar ones.
- **Evaluation:** weekly forecast dates; the latest 25 % are the test set. Training samples whose
  target window reaches into the test period are dropped, so nothing from the test weeks leaks into
  training. Metrics are MAE, RMSE, WAPE, MAPE (only where demand ≥ 5 units, where it is meaningful)
  and bias, on total units per product-location over the horizon.
- **Selection:** the lowest test MAE wins (a baseline wins if it is better). The winner is then
  retrained on all data and predicts from the latest date. The 10th–90th percentile of the test
  errors gives each prediction its range.
- With less than `56 + H` days of history no evaluation is possible: the service returns the
  moving average, marks the horizon `baseline_only` and claims no accuracy.

## Evaluate offline

```bash
cd cartify-backend
node scripts/exportForecastDataset.js forecast-dataset.json
ai-service/.venv/bin/python ai-service/scripts/evaluate.py forecast-dataset.json --markdown ai-service/EVALUATION.md
```

The report shows each model's test scores per horizon. With the synthetic demo dataset, which
includes the simulated true demand, it also compares stockout-aware training with naive training
(sold-out days counted as zero demand).

Add `--classical` to also score per-series exponential smoothing (statsmodels, damped trend on
weekly in-stock rates) and `--prophet N` to score Prophet on N random hold-out samples (one Prophet
fit per sample, so it is slow). Both are scored on exactly the same hold-out samples as the ML
models. They are not used by the service because the global ML models were more accurate (see
[EVALUATION.md](EVALUATION.md) for the latest run).

## Tests

```bash
cd ai-service && .venv/bin/python -m unittest discover -s tests
```
