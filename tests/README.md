# Cartify backend tests

Scripts that call a **running** backend over HTTP. They use only Node's built-in `fetch` (no test
framework). They create users, orders and stock movements, so **always point the backend at a test
database**, never at production.

```bash
# 1. Start MongoDB, then seed a TEST database
DB_URL=mongodb://127.0.0.1:27017/cartify_test npm run seed
DB_URL=mongodb://127.0.0.1:27017/cartify_test npm run seed:ai-demo

# 2. Start the AI forecasting service (see ai-service/README.md)
cd ai-service && .venv/bin/uvicorn app.main:app --port 8001 && cd ..

# 3. Start the backend on the test database
DB_URL=mongodb://127.0.0.1:27017/cartify_test AI_VERIFY=off npm start
```

| Script | What it checks | Extra setup |
|---|---|---|
| `npm run test:api` | Existing endpoints: catalog, guest cart (cookie and `X-Session-Id`), wishlist, login, admin checks, order flow and stock, order ownership, returns, cancel restores stock, logout (44 checks) | — |
| `npm run test:inventory` | Forecast run and model selection, forecast views, recommendations, approve/complete/cancel/reject with stock reservations, validation, stock adjustments, anomalies, report, admin-only access | AI service running |
| `npm run test:ai-tools` | Every shopping and inventory agent tool against the API, argument validation, confirmation-only cart actions, order privacy, customers blocked from inventory tools | AI service running, forecast run once |
| `npm run test:agents` | Full agent loop through `/assistant/*` with a scripted stand-in for the Claude API: tool calls, product/comparison/cart blocks, confirm/cancel, double-confirm, cross-user access, invalid tool arguments, loop cap, refusal, provider errors (500/401/429), inventory agent permissions | see below |

`test:agents` needs no API key and makes no paid calls. Start the stand-in, and start the backend
pointed at it:

```bash
IGNORE_NUDGE=1 node tests/mockAnthropic.mjs &
DB_URL=mongodb://127.0.0.1:27017/cartify_test AI_VERIFY=off ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:9999 ASSISTANT_RATE_LIMIT_PER_MIN=100 npm start
npm run test:agents
```

The forecasting model has its own unit tests: `cd ai-service && .venv/bin/python -m unittest discover -s tests`.
