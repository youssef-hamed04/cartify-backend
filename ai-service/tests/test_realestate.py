"""Train on the actual seeded Node demo generator, without MongoDB or servers."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

from fastapi import HTTPException
from app import realestate
from app.main import realestate_estimate
from app.schemas import RealEstateTrainRequest, RealEstateEstimateRequest


class RealEstateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Default mkdir permissions also work in restricted Windows runners, unlike
        # TemporaryDirectory's private ACL on recent Python versions.
        cls.temp = Path(tempfile.gettempdir()) / f'cartify-realestate-{uuid4().hex}'
        cls.temp.mkdir()
        cls.addClassCleanup(cls.cleanup)
        cls.old_models = realestate.MODELS.copy()
        realestate.MODELS.clear()
        cls.directory = patch.object(realestate, 'MODEL_DIR', cls.temp)
        cls.directory.start()
        root = Path(__file__).resolve().parents[2]
        generated = subprocess.check_output([
            'node', '--input-type=module', '-e',
            "import {generateMarketRows} from './db/data/realEstateSynthetic.js';"
            "console.log(JSON.stringify(generateMarketRows(6000,2026,new Date('2026-11-19T00:00:00Z'))));",
        ], cwd=root, text=True, encoding='utf-8')
        cls.rows = json.loads(generated)
        cls.metrics = realestate.train(RealEstateTrainRequest(rows=cls.rows, asOf='2026-11-19T00:00:00Z'))

    @classmethod
    def cleanup(cls):
        cls.directory.stop()
        realestate.MODELS.clear()
        realestate.MODELS.update(cls.old_models)
        for file in cls.temp.iterdir():
            file.unlink()
        cls.temp.rmdir()

    def request(self, **changes):
        return RealEstateEstimateRequest(**({
            'listingType': 'sale', 'propertyType': 'apartment', 'city': 'mansoura', 'district': 'toriel',
            'area': 120, 'rooms': 3, 'bathrooms': 2, 'floor': 2, 'hasElevator': True,
            'buildingAge': 10, 'finishing': 'super-lux', 'furnished': False, 'view': 'street',
        } | changes))

    def test_time_holdout_model_choice_and_accuracy(self):
        for kind, metrics in self.metrics.items():
            best = min(metrics['candidates'], key=lambda c: c['MAPE'])
            self.assertEqual(metrics['chosenModel'], best['model'])
            self.assertLess(best['MAPE'], .20, (kind, best))
            self.assertEqual(len(metrics['candidates']), 4)
            self.assertEqual(metrics['trainRows'] + metrics['holdoutRows'], metrics['rowCount'])
            self.assertAlmostEqual(metrics['holdoutRows'] / metrics['rowCount'], .15, delta=.001)

    def test_bigger_area_costs_more(self):
        for kind in ('sale', 'rent'):
            small = realestate.estimate(self.request(area=100, listingType=kind))
            large = realestate.estimate(self.request(area=200, listingType=kind))
            self.assertGreater(large['price'], small['price'])
            self.assertAlmostEqual(large['price'], large['pricePerM2'] * 200)
            self.assertGreater(small['low'], 0)
            self.assertGreater(small['high'], small['low'])

    def test_unknown_district(self):
        self.assertGreater(realestate.estimate(self.request(district='unseen-district'))['price'], 0)

    def test_missing_model_409(self):
        with patch.dict(realestate.MODELS, {}, clear=True):
            with self.assertRaises(HTTPException) as exc:
                realestate_estimate(self.request())
            self.assertEqual(exc.exception.status_code, 409)
            self.assertEqual(exc.exception.detail, 'model not trained')

    def test_persistence(self):
        expected = realestate.estimate(self.request())
        with patch.dict(realestate.MODELS, {}, clear=True):
            realestate.load_models()
            self.assertEqual(set(realestate.status()), {'sale', 'rent'})
            self.assertEqual(expected, realestate.estimate(self.request()))

    def test_insufficient_rows(self):
        with self.assertRaises(ValueError):
            realestate.train(RealEstateTrainRequest(rows=self.rows[:20], asOf='2026-11-19T00:00:00Z'))


if __name__ == '__main__':
    unittest.main()
