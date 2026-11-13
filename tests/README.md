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
| `npm run test:agents` | Full agent loop through `/assistant/*` with a scripted stand-in for Ollama: tool calls, product/comparison/cart blocks, automatic product cards, confirm/cancel, double-confirm, cross-user access, invalid and unknown tools, loop cap, empty replies, model not downloaded / server error / server down, inventory agent permissions, mobile-style requests | see below |
| `npm run test:ai-live` | **The real local model** (Ollama) on 11 scenarios: English and Arabic shopping (budget search, add to cart, compare, cart, order tracking) and inventory questions. Prints tools used, checks and time per answer. Use it to compare models on your hardware. | Ollama running with the model pulled; backend started with that `OLLAMA_MODEL` |

`test:agents` is fast and deterministic. Start the stand-in, and start the backend pointed at it:

```bash
IGNORE_NUDGE=1 node tests/mockOllama.mjs &
DB_URL=mongodb://127.0.0.1:27017/cartify_test AI_VERIFY=off OLLAMA_URL=http://127.0.0.1:11999 OLLAMA_MODEL=qwen3:4b-instruct ASSISTANT_RATE_LIMIT_PER_MIN=100 npm start
npm run test:agents
```

The forecasting model has its own unit tests: `cd ai-service && .venv/bin/python -m unittest discover -s tests`.
