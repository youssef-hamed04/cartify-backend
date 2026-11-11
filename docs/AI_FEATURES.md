# Cartify AI Features

Cartify gains three AI features on top of the existing system: **demand forecasting**,
**branch & inventory intelligence with an AI inventory agent**, and an **AI shopping assistant** for
the website and the mobile app. The existing Node.js + Express backend, MongoDB/Mongoose database,
authentication, routes and UI are unchanged. Everything new is added alongside them.

> **Free and open-source only.** No paid AI API, no API key, no subscription and no pay-per-request
> service is used. The agents run an open-weight model (**Qwen3** by default; **Gemma 4** for machines
> with 16 GB+ RAM; both Apache-2.0) on your own machine or server through **Ollama** (MIT). Forecasting
> uses scikit-learn, XGBoost, Prophet, pandas and NumPy (statsmodels in the offline comparison). Local inference has no per-request fee, but it uses the
> machine's CPU/GPU, memory and electricity. See section 12 for the technology audit.

> **About the demo data.** Cartify has no order history and no branches yet. To build and show the
> features, `npm run seed:ai-demo` generates a **synthetic** dataset: 4 sample branches in Mansoura
> and 2 years of daily sales with stockouts. It is stored separately (`syntheticsales`), flagged
> `isDemo` / `synthetic_demo`, and every screen and API response that uses it says
> "Synthetic demonstration data — not real sales". Forecasting switches to real orders automatically
> once there is enough history (56+ days with sales over 120+ days).

---

## 1. Summary

| Feature | What it does |
|---|---|
| **Demand forecasting** | A Python ML service trains and compares 6 models (2 baselines, ridge linear regression, random forest, scikit-learn gradient boosting, XGBoost) on daily sales per product and location. It picks the most accurate one on a time-based hold-out and predicts demand for the next 7, 30 or 90 days with a likely range. It handles stockouts (sold-out days are not treated as zero demand), compares predictions with current stock, computes safety stock and suggested replenishment, and flags rising/falling demand and shortage risk. Shown on a new **Demand Forecasting** admin page and a summary row on the dashboard. |
| **Branch & inventory intelligence** | New branch, branch-inventory, stock-movement and recommendation data. Shows stock per branch, low stock, spare and excess stock, unusual changes (large stock corrections, sales spikes or drops) and branch sales. A rules engine turns the forecast into **transfer and reorder recommendations** with written reasoning. Nothing moves until an admin approves (stock is reserved) and then completes (units move). Shown on a new **Branch & Inventory** admin page. |
| **Inventory agent** (AI) | A local open-source LLM agent (Qwen3 via Ollama) on the Branch & Inventory page that answers questions such as "Which products are likely to run out soon?" by calling 14 read-only admin tools. It can only *propose* a transfer request, and the admin must confirm it; the request still needs approval and completion. |
| **Shopping assistant** (AI) | A local open-source LLM agent (Qwen3 via Ollama) with 11 tools that use the store's existing APIs: natural-language search with budget filtering, product details, comparison, availability, personal recommendations (own orders and wishlist), cart, add to cart (only after the customer presses **Confirm**) and order tracking (own orders only). It is available as a chat button on every store page and as a new screen in the mobile app. Product cards, comparison tables, cart and order cards come from live data, and the model's text is labelled AI-generated. |

## 2. Architecture

```
 Website (HTML/JS)        Mobile app (Expo)          Admin pages (HTML/JS)
        │ cookie                  │ Bearer / X-Session-Id        │ cookie (admin)
        ▼                         ▼                              ▼
 ┌──────────────────────── Node.js + Express backend (unchanged core) ─────────────────────────┐
 │ existing modules: products, cart, orders, users, returns, …                                  │
 │ NEW  /assistant   agent loop (agentRunner) ── HTTP ──▶ Ollama (local open model, e.g. Qwen3)  │
 │        tools call the REST API with the caller's own token/session (internalApi.js)          │
 │ NEW  /forecasts   builds daily sales series ── HTTP ──▶ ai-service (Python, no DB access)    │
 │ NEW  /branches, /inventory   stock rules (stockPolicy) + workflow (inventory.service)        │
 └──────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                            ▼
                                 MongoDB (the same single database)
```

Design decisions (the least disruptive option each time):

- **Free and self-hosted.** The LLM runs locally through Ollama's HTTP API, called with plain
  `fetch` (no SDK, no framework such as LangChain/LangGraph: a small tool loop is simpler and easier
  to secure). The model never leaves your infrastructure and there is nothing to pay per request.
- **One backend, one database.** Python is used only where it is needed (the ML models). It runs as a
  separate service with a single endpoint, gets the data from Node, and never touches MongoDB. Node
  stores the results.
- **Agents reuse the existing APIs.** Every agent tool calls Cartify's own REST endpoints over HTTP
  with the *caller's* credentials. So `protectRoute`, `adminOnly`, express-validator and the
  existing ownership checks (for example "order belongs to this user or session") apply to the AI
  exactly as they do to the website. The AI has no direct database access and no copy of the
  business rules.
- **Shared business rules.** Safety stock, replenishment, surplus and transfer logic live in
  `stockPolicy.js` and `inventory.service.js`, used by the dashboard, the REST API and the agent
  alike. The model predicts; the agent interprets; the rules decide quantities.
- **Human confirmation for data changes.** Tools that would change data only create a *pending
  action*. It runs when the person presses **Confirm** in the UI, through the normal API. Stock
  transfers additionally need approve → complete by an admin.
- **Branch stock is separate from online stock.** Online stock stays on `product.variants` (existing
  behaviour, untouched). Branch stock is new (`branchinventories`, per product). Existing orders
  count as online-store sales.

## 3. Project structure (additions and changes only)

```
cartify-backend/
├── ai-service/                       NEW  Python forecasting service
│   ├── app/{main,schemas,features,forecaster}.py
│   ├── scripts/evaluate.py           offline evaluation report
│   ├── tests/test_forecaster.py
│   ├── requirements.txt, README.md, EVALUATION.md
├── db/
│   ├── seedAiDemo.js                 NEW  synthetic demo data (npm run seed:ai-demo)
│   └── models/
│       ├── order.model.js            CHANGED  + optional branchId (default null)
│       ├── branch, branchInventory, stockMovement, aiRecommendation,          NEW
│       ├── forecastRun, inventorySnapshot, syntheticSale,                     NEW
│       └── assistantConversation, aiActionLog                                 NEW
├── src/modules/
│   ├── forecast/                     NEW  routes, controller, service, data extraction, AI-service client
│   ├── inventory/                    NEW  routes, controller, service, stock rules, daily snapshots
│   ├── branch/                       NEW  routes, controller
│   └── assistant/                    NEW  routes, controller, agent loop, Ollama client, tools, prompts
├── scripts/exportForecastDataset.js  NEW
├── tests/                            NEW  API regression + AI/inventory/agent tests (see tests/README.md)
├── docs/AI_FEATURES.md               NEW  this document
├── index.js                          CHANGED  mounts 4 routers, starts the daily stock snapshot
└── package.json / .env.example / .gitignore / README.md   CHANGED

cartify-frontend/
├── admin-forecasting.html            NEW  Demand Forecasting page
├── admin-inventory.html              NEW  Branch & Inventory page (+ inventory agent chat)
├── admin-dashboard.html              CHANGED  + "Demand outlook" and "Branch stock alerts" row
├── CSS/admin-ai.css, CSS/assistant.css                      NEW
├── Js/assistant.js                   NEW  store chat widget
├── Js/main.js                        CHANGED  one import line loads the widget on every store page
├── Js/api.js, Js/admin-api.js        CHANGED  + API helpers
└── Js/admin-core.js                  CHANGED  + "Intelligence" sidebar section

cartify-mobile/src/
├── app/assistant.tsx                 NEW  Cartify Assistant screen
├── features/assistant/AssistantBlocks.tsx   NEW  product cards (existing ProductCard), comparison, cart, order, confirm
├── api/index.ts, api/types.ts        CHANGED  + assistantApi + types
├── app/(tabs)/index.tsx              CHANGED  + assistant button in the Home header
└── app/help.tsx                      CHANGED  + "Ask Cartify Assistant" card
```

No existing file was deleted, renamed or moved. Existing routes, controllers, middleware and models
behave as before (verified by the regression suite, section 10).

## 4. Database changes and seeding

New collections: `branches`, `branchinventories`, `stockmovements`, `airecommendations`,
`forecastruns`, `inventorysnapshots`, `syntheticsales`, `assistantconversations` (expire after 30
days), `aiactionlogs` (expire after 90 days). One optional field is added: `orders.branchId` (default
`null`, which means the online store). Existing documents need **no migration**.

```bash
npm run seed            # existing seeder (products, categories, admin, lockers)
npm run seed:ai-demo    # synthetic demo: 4 branches, 2 years × 45 products × 4 branches daily sales,
                        # current branch stock, recent deliveries/transfers, 1 stock-count anomaly
npm run seed:ai-demo -- --clean      # remove ONLY the demo data
npm run seed:ai-demo -- --days=365   # shorter history
```

The demo seeder only deletes and writes demo-flagged data. It refuses to run with
`NODE_ENV=production` unless you pass `--force`. Run it again after `npm run seed`, because that
recreates the products with new ids.

## 5. API endpoints

All responses use the existing format (`{ "msg": "success", ... }` / `{ "msg": "error", "err": "..." }`).

### Forecasting — `/forecasts` (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/forecasts/status` | AI-service health, chosen data source and why, latest run |
| POST | `/forecasts/run` | Train, evaluate and predict for 7/30/90 days, then save the run |
| GET | `/forecasts/latest` | Latest predictions with current stock. Query: `horizonDays` (7/30/90), `branchId` (`all`/`online`/id), `groupBy` (`location`/`product`), `trend`, `risk` (`high`/`medium`/`low`/`none`/`at_risk`), `search`, `sort`, `page`, `limit` |
| GET | `/forecasts/products/:id` | One product: weekly history (26 weeks, sold-out days) and forecast per location |
| GET | `/forecasts/runs` | Past runs with model scores |

`GET /forecasts/latest?horizonDays=30&limit=1` (trimmed):

```json
{
  "msg": "success",
  "run": { "asOf": "2026-11-09T00:00:00.000Z", "dataSource": "synthetic_demo", "isSynthetic": true,
           "dataLabel": "Synthetic demonstration data — not real sales" },
  "horizon": { "horizonDays": 30, "selectedModel": "gradient_boosting", "candidates": ["… MAE/RMSE/WAPE/MAPE/bias per model …"] },
  "summary": { "rows": 180, "totalPredicted": 20227.3, "highRisk": 16, "mediumRisk": 97, "increasing": 50, "replenishmentUnits": 9812 },
  "rows": [{
    "productName": "Smart Lens Camera", "branchName": "University Branch",
    "predictedDemand": 255.72, "low": 183.55, "high": 328.6, "trend": "stable", "trendPct": -0.09,
    "available": 0, "inbound": 0, "safetyStock": 45, "suggestedReplenishment": 301,
    "daysOfCover": 0, "shortageRisk": "high"
  }]
}
```

`shortageRisk`: **high** = stock runs out before a delivery could arrive (lead time); **medium** =
stock will not cover the forecast period; **low** = covers demand but not the safety stock.

### Branches — `/branches` (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/branches` | Branches with stock totals (`?status=`) |
| GET | `/branches/:id` | One branch |
| POST | `/branches` | Create: `{ code, name, address, city?, location?: {lat,lng}, status? }` |
| PATCH | `/branches/:id` | Update (deactivate with `status: "inactive"`; there is no delete because history refers to branches) |

### Inventory — `/inventory` (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/inventory/overview` | Per-branch stock, low stock, spare stock, forecast summary, lowest-inventory branch |
| GET | `/inventory/branches/:branchId` | Branch stock per product with forecast, cover and risk (`status=low/excess/out`, `search`, paging) |
| PATCH | `/inventory/branches/:branchId/products/:productId` | Stock count correction `{ quantity, safetyStock?, reason }` (logged as an adjustment) |
| GET | `/inventory/products/:productId` | One product across all branches plus online, with open movements |
| GET | `/inventory/sales` | Units and revenue per branch, change vs previous period, top products (`days`, `branchId`) |
| GET | `/inventory/low-stock` · `/inventory/excess` | Forecast-based shortages and surplus (`branchId`, `horizonDays`) |
| GET | `/inventory/transfer-suggestions` | Read-only transfer and reorder suggestions with reasoning |
| GET | `/inventory/anomalies` | Large stock corrections, sales spikes and drops |
| GET | `/inventory/report` | All of the above in one report |
| GET/POST | `/inventory/movements` | List, or create a transfer/replenishment **request** `{ type, productId, sourceBranchId, destinationBranchId, quantity, reason }` |
| PATCH | `/inventory/movements/:id/approve` · `/complete` · `/reject` · `/cancel` | Workflow. Approve reserves stock at the source; complete moves it; cancel releases it |
| GET | `/inventory/recommendations` | Saved recommendations (`status`, `type`) |
| POST | `/inventory/recommendations/generate` | Compute recommendations from the latest forecast `{ horizonDays }` |
| PATCH | `/inventory/recommendations/:id/approve` · `/reject` | Approve creates an approved movement (stock reserved) |
| POST | `/inventory/snapshots` | Record today's stock levels (for a cron job on serverless hosting) |

Transfer suggestion (from `GET /inventory/transfer-suggestions`, trimmed):

```json
{
  "productName": "Smart Watch Series X", "quantity": 5, "priority": "high", "distanceKm": 3.1,
  "from": { "branchName": "El-Mashaya Branch", "available": 134, "predictedDemand": 108.96, "safetyStock": 20, "surplus": 5 },
  "to":   { "branchName": "University Branch", "available": 39, "predictedDemand": 258.61, "safetyStock": 46, "shortage": 266, "daysOfCover": 4.5 },
  "reasoning": "University Branch is expected to sell about 259 units of Smart Watch Series X in the next 30 days (forecast). It has 39 available with a safety stock of 46, so it is 266 units short (about 4.5 days of cover). El-Mashaya Branch has 134 available against its own need of 129 (forecast 109 + safety 20), leaving 5 spare. Transferring 5 covers 2% of the shortage; the branches are 3.1 km apart."
}
```

### Assistant — `/assistant`

| Method | Path | Who | Description |
|---|---|---|---|
| GET | `/assistant/status` | anyone | `{ enabled }`: whether an AI key is configured |
| POST | `/assistant/chat` | customers and guests | `{ message, conversationId? }` → reply |
| GET / DELETE | `/assistant/conversations/:id` | owner only | Transcript / delete |
| POST | `/assistant/actions/:actionId/confirm` · `/cancel` | owner only | `{ conversationId }`: run or drop a pending action |
| POST | `/assistant/inventory/chat` (+ `/inventory/conversations/:id`, `/inventory/actions/...`) | admin | Inventory agent |

`POST /assistant/chat` `{ "message": "I need wireless headphones under $200" }`:

```json
{
  "msg": "success",
  "conversationId": "6af3…",
  "reply": {
    "text": "Here are two wireless headphones under $200 …",
    "aiGenerated": true,
    "blocks": [{ "type": "products", "title": "Headphones under $200",
                 "products": [{ "id": "…", "name": "Pro Sound Wireless Headphone", "price": 178.8, "rating": 4.5, "inStock": true, "image": "…" }] }]
  },
  "pendingActions": [],
  "toolCalls": ["search_products", "show_products"]
}
```

Block types: `products`, `comparison`, `cart`, `order`, `confirm_action` (shopping), and
`transfer_suggestions`, `confirm_action` (inventory). Blocks are built from tool results (live data),
never from model text.

## 6. Forecasting model

- **Data:** daily units sold per product and location with an in-stock flag. Real orders use the
  `orders` collection plus daily `inventorysnapshots` for stockout days. The demo uses `syntheticsales`.
- **Target:** average daily demand over the next H days, measured on in-stock days only.
- **Features:** stockout-aware demand rates (7/14/28/56/91 days), in-stock share, short- vs
  long-term trend, 8-week slope, price, discount, price change, month of the target window, time on
  sale, the same weeks last year (rate and seasonal swing), category and location.
- **Candidates (in the service, on every run), all free and open source:**
  - baselines: 28-day moving average and same-weeks-last-year seasonal naive;
  - global ML models, trained across all products and locations: ridge linear regression, random
    forest, histogram gradient boosting with a Poisson loss (scikit-learn) and **XGBoost** (Poisson
    objective);
  - **Prophet** (one model per product-location: trend + yearly and weekly seasonality, fitted on
    in-stock days only) and the **average of the best ML model and Prophet**.
- **Training and evaluation:** weekly forecast dates; the latest 25 % are a time-based test set, and
  training samples that overlap it are dropped. ML models are scored on every test sample. Prophet
  needs one fit per series and date, so it is scored on the test samples of 3 test dates spread over
  the test period, and Prophet or the average is selected only if it beats the best ML model **on
  exactly the same samples**. The winner is retrained on all data; its test errors give each
  prediction a 10–90 % range. A full run (3 horizons, 180 series, about 1,800 Prophet fits in parallel)
  takes about 65 s on 4 CPU cores. `FORECAST_PROPHET=off` skips Prophet ({{NOPROPHET}}).
- **Also compared offline** (`ai-service/scripts/evaluate.py --classical --prophet -1`): per-series
  exponential smoothing with a damped trend (statsmodels), and Prophet on every test sample.
- **Stock decisions** (`stockPolicy.js`): safety stock = max(z × σ × √(lead time ⁄ H), 3 days of
  demand) at a 95 % service level with a 7-day lead time; suggested reorder = forecast + safety −
  available − inbound. All of these settings are configurable.

**Results** on the synthetic demo data: MAE in units per product-location over the horizon, all
models on **every** test sample (full report: [ai-service/EVALUATION.md](../ai-service/EVALUATION.md)):

| Horizon (test samples) | Average XGBoost + Prophet | Prophet | XGBoost | scikit-learn gradient boosting | Exponential smoothing (statsmodels) | 28-day moving average |
|---|---:|---:|---:|---:|---:|---:|
| 7 days (4,232) | **5.59** | 5.98 | 5.76 | 5.81 | 5.94 | 6.16 |
| 30 days (4,139) | **14.82** | 16.70 | 16.19 | 16.24 | 18.90 | 20.37 |
| 90 days (3,780) | 35.39 | **35.22** | 45.99 | 48.25 | 56.69 | 62.53 |

The service picks the same winners from its 3-date sample: the average at 7 and 30 days, Prophet at
90 days (best ML model on the same samples: XGBoost). Compared with the 28-day moving average, the
error is 9 % lower at 7 days, 27 % at 30 days and 44 % at 90 days. Random forest and ridge
regression were behind XGBoost at every horizon.

What drives the result: short horizons depend mostly on recent sales (the 14–28-day rates are the top
ML features), which the ML models capture well; at 90 days the yearly pattern (back-to-school, White
Friday) dominates, and Prophet models it directly per series. Averaging the two combines both. With
less than a year of history the seasonal parts cannot be learnt and the models are close to the
moving average. Stockout handling, scored against the simulated true demand, lowered the error and
the under-forecasting at 7 and 30 days (30 days: MAE 16.27 vs 17.00, bias −2.1 % vs −4.3 %); at 90
days it did not help (46.01 vs 45.62) in this dataset, where only 2.4 % of days end sold out. These numbers
describe **synthetic data**, whose seasonality is regular and may suit Prophet better than real
sales; real accuracy must be measured again on real orders (the same script does that), and the
service re-selects the model on every run.

## 7. Agent tools and permissions

The agents run on a **local open-weight model through Ollama** (default `qwen3:4b-instruct`, see
section 9 for the model choice). The backend calls Ollama's `/api/chat` with the tool list and runs a
small tool loop (`agentRunner.js`): at most 6 model calls per message, every tool input validated
against its schema on the server (invalid or made-up ids are rejected and reported back to the
model), every tool call logged in `aiactionlogs`. Products named in a reply that the tools returned
in that turn are shown as live catalog cards even if the model does not call `show_products`, and
the server detects Arabic messages and tells the model to answer in Arabic.

**Shopping assistant**: runs with the customer's own token or guest session.

| Tool | Calls | Changes data? |
|---|---|---|
| `get_catalog_overview` | `GET /products/categories`, `/products/brands` | no |
| `search_products` | `GET /products` (one search per keyword, merged; looser matching for phrases and spacing; final-price budget filter; asks for English keywords if given Arabic ones) | no |
| `get_product_details` | `GET /products/:id`, `/products/:id/reviews` | no |
| `compare_products` | `GET /products/:id` ×2–4 | no |
| `check_product_availability` | `GET /products/:id` | no |
| `get_cart` | `GET /cart` | no |
| `add_to_cart` | validates via `GET /products/:id`; **on Confirm only**: `POST /cart` | after confirmation |
| `get_my_orders` | `GET /orders/my` (own orders only) | no |
| `track_order` | `GET /orders/my` then `GET /orders/:id` (ownership enforced by the API) | no |
| `get_shopping_profile` | own `GET /orders/my`, `GET /wishlist` | no |
| `show_products` | `GET /products/:id`: displays product cards | no |

The assistant cannot check out, pay, cancel orders or change addresses.

**Inventory agent**: admins only; runs with the admin's token.

| Tool | Calls |
|---|---|
| `get_all_branches` · `get_inventory_overview` · `get_branch_inventory` · `get_product_stock_across_branches` · `get_branch_sales` · `get_demand_forecast` · `identify_low_stock` · `identify_excess_stock` · `suggest_stock_transfer` · `get_stock_movement_history` · `get_recommendations` · `detect_inventory_anomalies` · `generate_inventory_report` | read-only `/branches`, `/inventory/*`, `/forecasts/latest` |
| `create_stock_transfer_request` | **on Confirm only**: `POST /inventory/movements`, which creates a *requested* movement that still needs approval and completion |

## 8. Environment variables (backend `.env`)

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs (same machine, or a private server) |
| `OLLAMA_MODEL` | `qwen3:4b-instruct` | Local model for both agents. Ollama *cloud* models (names ending in `-cloud`) are refused. |
| `OLLAMA_NUM_CTX` | 8192 | Context window in tokens (more = more RAM) |
| `OLLAMA_THINK` | off | `on` lets hybrid Qwen3 models (e.g. `qwen3:8b`) reason before answering: better on hard questions, much slower on a CPU |
| `OLLAMA_TEMPERATURE` | 0.4 | Lower = more predictable tool use |
| `OLLAMA_KEEP_ALIVE` | `30m` | Keep the model in memory between chats (first answer after unload is slower) |
| `OLLAMA_TIMEOUT_MS` | 240000 | Max time for one model call |
| `OLLAMA_MAX_CONCURRENT` / `OLLAMA_MAX_QUEUE` | 1 / 8 | Model calls at the same time / chats allowed to wait before "busy" is returned |
| `OLLAMA_WARMUP` | on | Load the model and pre-process the shopping assistant's instructions at server start |
| `ASSISTANT_RATE_LIMIT_PER_MIN` | 15 | Chat messages per user or session per minute |
| `INTERNAL_API_URL` | `http://127.0.0.1:$PORT` | How agent tools reach the API. Set it to the public URL on serverless hosting. |
| `AI_SERVICE_URL` / `AI_SERVICE_KEY` | `http://127.0.0.1:8001` / — | Forecasting service and shared secret (set the same key on the service) |
| `AI_SERVICE_TIMEOUT_MS` | 120000 | Max time for one forecasting run |
| `FORECAST_PROPHET` / `FORECAST_PROPHET_EVAL_DATES` / `FORECAST_WORKERS` | on / 3 / all cores | **Set on the AI service.** Prophet candidates on or off, test dates used to score them, parallel processes |
| `FORECAST_DATA_SOURCE` | `auto` | `auto`, `orders` or `synthetic_demo` |
| `FORECAST_LOOKBACK_DAYS` | 730 | History used for training |
| `FORECAST_LEAD_TIME_DAYS` / `FORECAST_SERVICE_LEVEL` | 7 / 0.95 | Safety stock |
| `SAFETY_STOCK_MIN_DAYS` / `EXCESS_COVER_DAYS` / `MIN_TRANSFER_QTY` / `LOW_STOCK_UNITS` | 3 / 60 / 2 / 5 | Stock rules |
| `INVENTORY_SNAPSHOTS` | on | Daily stock snapshot (automatically off on Vercel) |

No variable holds a paid API key: there is none.

## 9. Installation and running

### 9.1 Hardware

No GPU is required. Measured on the development machine (4-core Intel Xeon 2.1 GHz with AVX-512,
15 GB RAM, **no GPU**):

| Model (Ollama tag) | Download | RAM in use | Speed on 4 CPU cores (read / write) | Agent result |
|---|---:|---:|---|---|
| **`qwen3:4b-instruct`** (Qwen3-4B-Instruct-2507, Apache-2.0) — **default** | 2.5 GB | 4.3 GB | 76 / 6.3 tokens/s | **22 / 22** (two full runs); median 57 s, slowest 120 s |
| `gemma4:e4b` (Gemma 4 E4B, Apache-2.0) | 6.6 GB | 7.8 GB | 66 / 4.9 tokens/s | 21 / 22¹; median **19 s**, slowest 70 s: the fastest end to end (shorter answers) |
| `qwen3.5:4b` (Apache-2.0) | 3.3 GB | 4.8 GB | 73 / 6.8 tokens/s | 21 / 22²; median 50 s, slowest 89 s |
| `qwen3:8b` (Apache-2.0) | 5.2 GB | ~6.8 GB | 43 / 4.1 tokens/s | 10 / 11³; median 60 s, slowest 274 s |
| `qwen3:1.7b` (Apache-2.0) | 1.4 GB | ~2 GB | 175 / 14 tokens/s | 0 / 11: wrote tool calls as plain text instead of calling the tools |
| `qwen3:4b` (the tag is the *Thinking-2507* build) | 2.5 GB | ~4 GB | ~77 / 7.5 tokens/s | always reasons at length first: the first answer did not finish within 4 minutes |

"Read" is prompt processing, "write" is generation, measured with a 1,100-token prompt; RAM is the
model process's resident memory after the 11 scenarios (8,192-token context). Agent result = the 11
English/Arabic scenarios of `npm run test:ai-live` (section 10).
¹ Once asked which colour to add instead of preparing the cart item. The prompt tells it to do that
for products with several colours, so the test now accepts it (it would be 22 / 22).
² Once asked a question instead of calling `suggest_stock_transfer`; the prompt now says to answer broad
questions with the tools' defaults.
³ Measured before two fixes: it passed invented product ids to `compare_products`, which now also
accepts product names and tells the model to search first. Removed afterwards to free disk space.

**Recommendation:**

| Your machine | Model | What to expect |
|---|---|---|
| 8 GB RAM, 4+ CPU cores, no GPU (laptop / small VPS) | **`qwen3:4b-instruct`** (default) | Passed every scenario in English and Arabic; about 10–60 s per shopping answer and 1.5–2 min per inventory answer on 4 cores. More cores = faster. |
| 16 GB RAM or more, CPU only | **`gemma4:e4b`** | About 3× faster answers in our test (median 19 s); needs about 8 GB free RAM. |
| Apple Silicon (M1+) or an NVIDIA GPU with 8 GB+ VRAM | `gemma4:e4b`, `qwen3:8b` or `qwen3.5:4b` | A few seconds per answer. Run `npm run test:ai-live` and keep the model that passes the most scenarios on your data. |
| Less than 8 GB RAM | — | Smaller models (`qwen3:1.7b`) did not call the tools, so the agents would not work. Run Ollama on another machine on your network and set `OLLAMA_URL`. |

Why not simply the largest model? `qwen3:8b` fits in 15 GB RAM, but on a 4-core CPU it writes about 4
tokens per second, so an inventory answer took up to 4.5 minutes, and it did no better than the 4B
models. On a GPU it is a good choice. **Gemma 3** (`gemma3:*`) cannot be used: its Ollama template has
no tool support, so the agents could not call any tool. **Gemma 4** and **Qwen3.5** support tools and
need Ollama 0.30.9 or newer (tested with 0.40.11).

### 9.2 Install

```bash
# 1. Backend
cd cartify-backend
npm install
cp .env.example .env          # fill in DB_URL, JWT_SECRET, AI_SERVICE_KEY (any long random string), …
npm run seed && npm run seed:ai-demo

# 2. Forecasting service (Python 3.11+)
cd ai-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt     # Windows: .venv\Scripts\pip …
cd ..

# 3. Local LLM: install Ollama (free, MIT) from https://ollama.com/download (Windows, macOS, Linux)
#    Linux: curl -fsSL https://ollama.com/install.sh | sh
#    or Docker (CPU): docker run -d --name ollama -p 11434:11434 -e OLLAMA_NO_CLOUD=1 -v ollama:/root/.ollama ollama/ollama:0.40.11
ollama pull qwen3:4b-instruct  # one-time download, ~2.5 GB (qwen3:8b: ~5.2 GB)
```

Set `OLLAMA_NO_CLOUD=1` in the environment of the Ollama server (Docker `-e`, or the service's
environment on Linux/Windows/macOS). It turns off Ollama's optional cloud features (remote models,
web search) so nothing leaves your machine and no paid plan can be involved by mistake.

### 9.3 Start (three processes + MongoDB)

```bash
ollama serve                                   # if it is not already running as a service
cd cartify-backend/ai-service && AI_SERVICE_KEY=<same as .env> .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
cd cartify-backend && npm run dev              # logs "🤖 Local AI model … ready" after the warm-up
```

Then serve `cartify-frontend` on an origin listed in `ALLOWED_ORIGINS` (e.g. port 5500): Admin →
Demand Forecasting → **Run forecast**, then Branch & Inventory → **Generate recommendations**; the
chat button appears on every store page. Mobile: `cd cartify-mobile && npx expo start` (Home → ✨ or
Help Center → Ask Cartify Assistant). Check the model: `GET /assistant/status` → `{"enabled": true, "model": "qwen3:4b-instruct"}`.

Test the agents on your own hardware with the real model:

```bash
OLLAMA_MODEL=qwen3:4b-instruct npm start   # on a test database
npm run test:ai-live                       # 11 English/Arabic scenarios, prints tools, checks and time
```

### 9.4 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Chat says "The AI assistant is not available right now" | Ollama is not running or the model is not downloaded. `GET /assistant/status` as an admin shows the reason. Start `ollama serve` and run `ollama pull <OLLAMA_MODEL>`. |
| "The assistant took too long to answer" | The machine is slow for the model: use `qwen3:4b-instruct`, close other heavy programs, raise `OLLAMA_TIMEOUT_MS`, or run Ollama on a faster machine/GPU and set `OLLAMA_URL`. |
| "The assistant is busy with other customers" | More chats than `OLLAMA_MAX_CONCURRENT` + `OLLAMA_MAX_QUEUE`. On a GPU set `OLLAMA_NUM_PARALLEL=2+` on Ollama and raise `OLLAMA_MAX_CONCURRENT`. |
| First answer after a while is slow | The model was unloaded. Raise `OLLAMA_KEEP_ALIVE` (e.g. `2h`) or keep `OLLAMA_WARMUP=on`. |
| The model answers without searching, or invents products | The model is too small (e.g. `qwen3:1.7b`). Use `qwen3:4b-instruct` or larger. Made-up product ids are always rejected by the server; only real catalog data is shown as cards. |
| Replies in the wrong language | The server already asks for Arabic when the message contains Arabic letters; larger models follow it more reliably. |
| Out of memory / swapping | Lower `OLLAMA_NUM_CTX` (e.g. 4096) or use a smaller model. `qwen3:4b-instruct` needs about 4–5 GB free RAM. |
| Mobile app shows a network error while waiting | The app allows 5 minutes for assistant answers (`src/api/index.ts`); if your server is slower, use a faster model/machine. A reverse proxy (nginx) in front of the backend also needs a long `proxy_read_timeout`. |
| Forecasting: "The demand forecasting service is not reachable" | Start the Python service (9.3) and check `AI_SERVICE_URL` / `AI_SERVICE_KEY`. Saved forecasts stay visible meanwhile. |
| Forecasting run is slow or times out | Prophet fits one model per series. On a slow machine or with many products, set `FORECAST_PROPHET=off` on the AI service, lower `FORECAST_PROPHET_EVAL_DATES`, or raise `AI_SERVICE_TIMEOUT_MS` on the backend (default 120000). |

## 10. Testing results

All results come from a local MongoDB 7 with the demo data and a CPU-only machine (4 cores, no GPU).

| Suite | Result |
|---|---|
| `npm run test:api`: existing endpoints (catalog, cart via cookie and `X-Session-Id`, wishlist, login and admin checks, order flow, stock decrement, order ownership, returns, cancel restores stock, logout). Run **before and after** the changes. | 44 / 44 passed |
| `npm run test:inventory`: forecast run and model selection, views, recommendations, approve/complete/cancel/reject with reservations, validation, adjustments, anomalies, report, admin-only access | 34 / 34 passed (selected: XGBoost + Prophet average at 7 and 30 days, Prophet at 90 days) |
| `npm run test:ai-tools`: every agent tool against the API, schema validation, confirmation-only actions, order privacy, customers and guests blocked from inventory tools | 43 / 43 passed |
| `npm run test:agents`: agent loop end to end with a scripted Ollama stand-in (tool calls, blocks, automatic product cards, confirm/cancel, double-confirm, cross-user access, invalid/unknown tools, loop cap, empty replies, model missing / server error / server down, inventory agent permissions) and mobile-style requests | 39 / 39 + 8 / 8 passed |
| `npm run test:ai-live`: **the real local model** on 11 English/Arabic scenarios | `qwen3:4b-instruct`: 11 / 11, twice. Other models: section 9.1 |
| `ai-service` unit tests | 6 / 6 passed |
| Browser checks (Playwright): Demand Forecasting, Branch & Inventory (recommendations, agent chat, confirm card), dashboard, store widget on desktop and iPhone size | no console errors from the new code |
| Mobile app: `tsc --noEmit` and `expo lint` | typecheck passes; lint: 0 errors (1 warning in the existing `checkout.tsx`, unchanged) |

**Live agent scenarios** (`qwen3:4b-instruct`, the default; times on the 4-core CPU):

| Scenario | Tools the model called | Time | Result |
|---|---|---:|---|
| EN · "I need wireless headphones under $200" | `search_products` | 21 s | passed: product cards, all ≤ $200 |
| EN · "Add the first one to my cart please" | `add_to_cart` | 22 s | passed: confirmation card, cart unchanged until Confirm |
| EN · "Compare the Ghost Audio Elite with the Soundcore R50i" | `search_products`, `compare_products` | 57 s | passed: comparison table |
| AR · "أريد ساعة ذكية بسعر أقل من 600 دولار" | `search_products` | 20 s | passed: Smart Watch Series X, answer in Arabic |
| AR · "ما الموجود في سلة التسوق الخاصة بي؟" | `get_cart` | 11 s | passed: answer in Arabic |
| AR · "أين طلبي رقم ABC123؟" | `track_order` | 18 s | passed: says the order was not found, in Arabic |
| EN · "Which branch has the lowest inventory?" | `get_inventory_overview` | 96 s | passed: names the right branch |
| AR · "ما المنتجات التي من المحتمل أن تنفد قريبًا في فرع الجامعة؟" | `identify_low_stock` | 120 s | passed: answer in Arabic |
| EN · "What should we transfer between branches this week?" | `suggest_stock_transfer` | 79 s | passed |
| EN · "Compare sales between branches for the last 30 days" | `get_branch_sales` | 95 s | passed |
| EN · "Which products have increasing demand?" | `get_demand_forecast` | 99 s | passed |

The model chose a fitting tool in every scenario. The checks are automatic (right tool, cards or
tables present, budget respected, Arabic reply, correct branch name); the full replies are in the
JSON written by `--out`.
Times include loading the tool results into the model; the first message after start-up also waits
for the warm-up (about 40 s).

## 11. Known limitations and next steps

- **Speed on a CPU.** A local model on a 4-core CPU takes about 15–60 s per shopping answer and
  1.5–2 min per inventory answer. That is acceptable for a demo or a small shop; for many customers at
  once, run Ollama on a machine with a GPU or Apple Silicon (answers in seconds) and raise
  `OLLAMA_MAX_CONCURRENT`. There is still no per-request fee; the cost is hardware and electricity.
- **Small-model quality.** A 4B model sometimes picks a less helpful tool or mixes languages. The
  server limits the damage: tool inputs are validated, made-up ids are rejected, cards only show real
  catalog data, and nothing is added or moved without a human pressing Confirm/Approve.
- **Synthetic data.** All forecast accuracy figures come from simulated sales. Real accuracy will be
  known only after several months of real orders. Yearly seasonality needs about 2 years of history.
- **Branch stock is per product, not per colour,** and is separate from the online store's variant
  stock. Online orders don't take stock from branches. Linking them (for example, fulfilling online
  orders from a branch via `orders.branchId`) is the main next step for branch operations.
- **Network topology between branches is not decided.** The branch module makes no assumptions
  about it; branches are independent stock locations reached through the central API.
- **Approvals use the existing `admin` role.** There is no separate "branch manager" role yet.
- **Currency:** prices are used exactly as the store lists them (shown as `$`); the assistant does not
  convert EGP budgets.
- **Product data is thin** (short English descriptions, no structured specs). Semantic search with a
  free local embedding model (e.g. a multilingual sentence-transformer through the
  `@huggingface/transformers` package the backend already uses) would help with a larger catalog;
  for 45 products, the model's English keywords plus the looser matching were enough in the tests.
- **Daily snapshots** run inside the Node process. On serverless hosting, call
  `POST /inventory/snapshots` from a daily cron job, and host Ollama and the AI service on a normal
  server (they cannot run on Vercel).
- **The mobile Assistant screen** passed typecheck and lint but wasn't run on a device or simulator.

## 12. Free and open-source technology (audit)

Every AI component is free and open source and runs on your own hardware.

| Proposed technology (first version) | Paid or free? | Free alternative | Final choice |
|---|---|---|---|
| Claude API (`claude-opus-5-5`) for both agents | Paid per token | Local open-weight LLM | **Qwen3 via Ollama (MIT)**, `qwen3:4b-instruct` by default; `gemma4:e4b` with 16 GB+ RAM (both Apache-2.0). Six models compared in section 9.1. |
| `@anthropic-ai/sdk` | Free library for a paid API | Plain `fetch` to Ollama's local HTTP API | **Removed** |
| Anthropic prompt caching / refusal fallbacks | Paid API features | Ollama's automatic prompt-prefix reuse | Ollama built-in |
| Ollama cloud models / web search | Optional paid service | Local models only | **Disabled** (`OLLAMA_NO_CLOUD=1`; backend refuses `*-cloud` models) |
| Agent framework | — | LangGraph, LangChain | **Own ~150-line tool loop** (simplest; no extra dependency) |
| scikit-learn, NumPy, FastAPI, uvicorn, pydantic | Free (BSD/MIT) | — | Kept |
| XGBoost | Free (Apache-2.0) | — | **Added** as a forecasting candidate |
| Prophet, pandas | Free (MIT/BSD) | — | **Added**: Prophet and the ML + Prophet average are forecasting candidates (most accurate in the tests) |
| statsmodels | Free (BSD) | — | Offline comparison only (`requirements-eval.txt`): exponential smoothing was less accurate |
| MongoDB (existing) | Community Server is free; the existing `.env` also mentions MongoDB Atlas (cloud) | MongoDB Community, local or self-hosted | Kept as is; the AI features add no new database and work on local MongoDB |
| Vector database / embeddings | not used | sentence-transformers, FAISS, Chroma (local) | Not added (no measurable benefit for 45 products; see section 11) |
| Hosting | — | Self-hosting | Ollama and the AI service run on your own machine/server; no paid AI hosting |

Existing non-AI services (Cloudinary image hosting, Vercel, Google Maps key and Apple developer
account for the mobile app) are unchanged and not used by the AI features.
