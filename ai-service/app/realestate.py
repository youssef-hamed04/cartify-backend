"""Per-listing-type market regressions. No database access; persisted local artifacts only."""
from datetime import datetime, timezone
from pathlib import Path
import logging
import os
from threading import RLock
from uuid import uuid4

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_absolute_percentage_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, FunctionTransformer, StandardScaler
from xgboost import XGBRegressor

MODEL_DIR = Path(__file__).resolve().parents[1] / 'models'
MODELS = {}
LOCK = RLock()
CATEGORICAL = ['city', 'district', 'propertyType', 'finishing', 'view']
NUMERIC = ['rooms', 'bathrooms', 'floor', 'hasElevator', 'buildingAge', 'furnished', 'monthsAgo']


def load_models():
    with LOCK:
        for kind in ('sale', 'rent'):
            path = MODEL_DIR / f'realestate-{kind}.joblib'
            if path.exists():
                try:
                    MODELS[kind] = joblib.load(path)
                except Exception:
                    logging.exception('Unable to load real estate model %s', kind)


def status():
    with LOCK:
        return {kind: value['metrics'] for kind, value in MODELS.items()}


def features(rows, as_of=None):
    frame = pd.DataFrame(rows)
    frame['monthsAgo'] = 0.0 if as_of is None else (
        pd.Timestamp(as_of) - pd.to_datetime(frame['transactionDate'], utc=True)
    ).dt.total_seconds() / (86400 * 30.4375)
    return frame[CATEGORICAL + ['area'] + NUMERIC]


def pipeline(estimator):
    transform = ColumnTransformer([
        ('category', OneHotEncoder(handle_unknown='ignore', sparse_output=False), CATEGORICAL),
        ('area', FunctionTransformer(np.log, feature_names_out='one-to-one'), ['area']),
        ('numeric', StandardScaler(), NUMERIC),
    ])
    return Pipeline([('features', transform), ('regressor', estimator)])


def train(request):
    rows = [r.model_dump() for r in request.rows]
    as_of = pd.Timestamp(request.asOf)
    if as_of.tzinfo is None:
        as_of = as_of.tz_localize('UTC')
    updates = {}
    # Serialize training to prevent simultaneous first-use requests overwriting artifacts.
    with LOCK:
        for kind in ('sale', 'rent'):
            subset = [r for r in rows if r['listingType'] == kind]
            if not subset:
                continue
            if len(subset) < 20:
                raise ValueError(f'At least 20 market rows are required for {kind}')
            subset.sort(key=lambda r: pd.to_datetime(r['transactionDate'], utc=True))
            x = features(subset, as_of)
            y = np.array([r['pricePerM2'] for r in subset])
            split = int(len(y) * .85)
            candidates = {
                'Ridge': Ridge(alpha=1.0),
                'RandomForestRegressor': RandomForestRegressor(n_estimators=100, min_samples_leaf=2, random_state=42, n_jobs=1),
                'HistGradientBoostingRegressor': HistGradientBoostingRegressor(max_iter=160, max_leaf_nodes=20, l2_regularization=1, random_state=42),
                'XGBRegressor': XGBRegressor(n_estimators=180, max_depth=4, learning_rate=.06, objective='reg:squarederror', random_state=42, n_jobs=1),
            }
            scores, fitted = [], {}
            for name, estimator in candidates.items():
                model = pipeline(estimator)
                model.fit(x.iloc[:split], np.log(y[:split]))
                prediction = np.exp(model.predict(x.iloc[split:]))
                scores.append({'model': name, 'MAE': float(mean_absolute_error(y[split:], prediction)),
                               'MAPE': float(mean_absolute_percentage_error(y[split:], prediction)),
                               'R2': float(r2_score(y[split:], prediction))})
                fitted[name] = (model, prediction)
            best = min(scores, key=lambda s: s['MAPE'])
            model, prediction = fitted[best['model']]
            ratios = np.quantile(y[split:] / prediction, [.1, .9]).tolist()
            model = clone(model).fit(x, np.log(y))
            metrics = {'chosenModel': best['model'], 'candidates': scores, 'rowCount': len(y),
                       'trainRows': split, 'holdoutRows': len(y) - split,
                       'trainedAt': datetime.now(timezone.utc).isoformat()}
            logging.info('realestate %s: selected %s, hold-out MAPE %.2f%% (%d rows)',
                         kind, best['model'], best['MAPE'] * 100, len(y))
            updates[kind] = {'pipeline': model, 'ratios': ratios, 'metrics': metrics}
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        for kind, artifact in updates.items():
            target = MODEL_DIR / f'realestate-{kind}.joblib'
            temp = MODEL_DIR / f'.{kind}-{uuid4().hex}.tmp'
            try:
                joblib.dump(artifact, temp)
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)
        MODELS.update(updates)
    return {kind: value['metrics'] for kind, value in updates.items()}


def estimate(request):
    with LOCK:
        artifact = MODELS.get(request.listingType)
    if artifact is None:
        raise LookupError('model not trained')
    per_m2 = float(np.exp(artifact['pipeline'].predict(features([request.model_dump()]))[0]))
    price = per_m2 * request.area
    return {'pricePerM2': per_m2, 'price': price, 'low': price * artifact['ratios'][0],
            'high': price * artifact['ratios'][1], 'model': artifact['metrics']['chosenModel'],
            'trainedAt': artifact['metrics']['trainedAt']}
