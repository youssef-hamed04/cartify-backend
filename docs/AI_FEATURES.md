# Cartify AI Features

Cartify gains three AI features on top of the existing system: **demand forecasting**,
**branch & inventory intelligence with an AI inventory agent**, and an **AI shopping assistant** for
the website and the mobile app. The existing Node.js + Express backend, MongoDB/Mongoose database,
authentication, routes and UI are unchanged. Everything new is added alongside them.

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
| **Demand forecasting** | A Python ML service trains and compares 5 models (2 baselines, ridge linear regression, random forest, gradient boosting) on daily sales per product and location. It picks the most accurate one on a time-based hold-out and predicts demand for the next 7, 30 or 90 days with a likely range. It handles stockouts (sold-out days are not treated as zero demand), compares predictions with current stock, computes safety stock and suggested replenishment, and flags rising/falling demand and shortage risk. Shown on a new **Demand Forecasting** admin page and a summary row on the dashboard. |
| **Branch & inventory intelligence** | New branch, branch-inventory, stock-movement and recommendation data. Shows stock per branch, low stock, spare and excess stock, unusual changes (large stock corrections, sales spikes or drops) and branch sales. A rules engine turns the forecast into **transfer and reorder recommendations** with written reasoning. Nothing moves until an admin approves (stock is reserved) and then completes (units move). Shown on a new **Branch & Inventory** admin page. |
| **Inventory agent** (AI) | A Claude agent on the Branch & Inventory page that answers questions such as "Which products are likely to run out soon?" by calling 14 read-only admin tools. It can only *propose* a transfer request, and the admin must confirm it; the request still needs approval and completion. |
| **Shopping assistant** (AI) | A Claude agent with 11 tools that use the store's existing APIs: natural-language search with budget filtering, product details, comparison, availability, personal recommendations (own orders and wishlist), cart, add to cart (only after the customer presses **Confirm**) and order tracking (own orders only). It is available as a chat button on every store page and as a new screen in the mobile app. Product cards, comparison tables, cart and order cards come from live data, and the model's text is labelled AI-generated. |

## 2. Architecture

```
 Website (HTML/JS)        Mobile app (Expo)          Admin pages (HTML/JS)
        │ cookie                  │ Bearer / X-Session-Id        │ cookie (admin)
        ▼                         ▼                              ▼
 ┌──────────────────────── Node.js + Express backend (unchanged core) ─────────────────────────┐
 │ existing modules: products, cart, orders, users, returns, …                                  │
 │ NEW  /assistant   agent loop (agentRunner) ── Claude Messages API (key only on the server)   │
 │        tools call the REST API with the caller's own token/session (internalApi.js)          │
 │ NEW  /forecasts   builds daily sales series ── HTTP ──▶ ai-service (Python, no DB access)    │
 │ NEW  /branches, /inventory   stock rules (stockPolicy) + workflow (inventory.service)        │
 └──────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                            ▼
                                 MongoDB (the same single database)
```

Design decisions (the least disruptive option each time):

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
│   └── assistant/                    NEW  routes, controller, agent loop, Claude client, tools, prompts
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
- **Models compared:** 28-day moving average and same-weeks-last-year seasonal naive (baselines),
  ridge linear regression, random forest, and histogram gradient boosting with a Poisson loss
  (XGBoost-style; real XGBoost is added automatically if installed).
- **Training and evaluation:** weekly forecast dates; the latest 25 % are a time-based test set, and
  training samples that overlap it are dropped. The lowest test MAE is selected, then retrained on all
  data. The test errors give each prediction its 10–90 % range.
- **Stock decisions** (`stockPolicy.js`): safety stock = max(z × σ × √(lead time ⁄ H), 3 days of
  demand) at a 95 % service level with a 7-day lead time; suggested reorder = forecast + safety −
  available − inbound. All of these settings are configurable.

**Results** on the synthetic demo data (full report: [ai-service/EVALUATION.md](../ai-service/EVALUATION.md)):

| Horizon | Selected model | MAE | WAPE | MAE of 28-day moving average | Improvement |
|---|---|---:|---:|---:|---:|
| 7 days | Gradient boosting | 5.81 | 25.6 % | 6.16 | 5.8 % |
| 30 days | Gradient boosting | 16.24 | 17.0 % | 20.37 | 20.3 % |
| 90 days | Gradient boosting | 48.25 | 17.3 % | 62.53 | 22.8 % |

Gradient boosting beat random forest, linear regression and both baselines at every horizon. Most of
the gain at 30 and 90 days comes from the last-year features (seasonality such as back-to-school and
White Friday); with a single year of history the models barely beat the moving average. Stockout
handling, scored against the simulated true demand, lowered the error and the under-forecasting at 7
and 30 days (30 days: MAE 16.36 vs 16.84, bias −2.5 % vs −4.7 %). It did not help at 90 days in this
dataset, where only 2.4 % of days end sold out. An earlier version of the demo data with more
stockouts showed a much larger gain (30 days: 16.2 vs 21.8). These numbers describe **synthetic
data**; real accuracy must be measured again on real orders (the same report script does that).

## 7. Agent tools and permissions

Model: `claude-opus-5-5` (configurable) with adaptive thinking, effort `medium`, prompt caching and
server-side refusal fallback. Every tool input is validated against its schema on the server; invalid
input is rejected and reported back to the model. At most 8 model calls run per message. Every tool
call is logged in `aiactionlogs`.

**Shopping assistant**: runs with the customer's own token or guest session.

| Tool | Calls | Changes data? |
|---|---|---|
| `get_catalog_overview` | `GET /products/categories`, `/products/brands` | no |
| `search_products` | `GET /products` (one search per keyword, merged; final-price budget filter) | no |
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
| `ANTHROPIC_API_KEY` | — | Claude API key for both agents (server only). Without it the agents report "not available" and everything else works. |
| `AI_MODEL` / `AI_EFFORT` / `AI_FALLBACKS` | `claude-opus-5-5` / `medium` / on | Model settings |
| `ASSISTANT_RATE_LIMIT_PER_MIN` | 15 | Chat messages per user or session per minute |
| `INTERNAL_API_URL` | `http://127.0.0.1:$PORT` | How agent tools reach the API. Set it to the public URL on serverless hosting. |
| `AI_SERVICE_URL` / `AI_SERVICE_KEY` | `http://127.0.0.1:8001` / — | Forecasting service and shared secret (set the same key on the service) |
| `FORECAST_DATA_SOURCE` | `auto` | `auto`, `orders` or `synthetic_demo` |
| `FORECAST_LOOKBACK_DAYS` | 730 | History used for training |
| `FORECAST_LEAD_TIME_DAYS` / `FORECAST_SERVICE_LEVEL` | 7 / 0.95 | Safety stock |
| `SAFETY_STOCK_MIN_DAYS` / `EXCESS_COVER_DAYS` / `MIN_TRANSFER_QTY` / `LOW_STOCK_UNITS` | 3 / 60 / 2 / 5 | Stock rules |
| `INVENTORY_SNAPSHOTS` | on | Daily stock snapshot (automatically off on Vercel) |

## 9. Installation and running

```bash
# Backend
cd cartify-backend
npm install
cp .env.example .env          # fill in DB_URL, JWT_SECRET, ANTHROPIC_API_KEY, AI_SERVICE_KEY, …
npm run seed && npm run seed:ai-demo

# AI service (second terminal)
cd cartify-backend/ai-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
AI_SERVICE_KEY=<same as .env> .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001

# Backend (back in cartify-backend)
npm run dev

# Website: serve cartify-frontend on an origin listed in ALLOWED_ORIGINS, e.g. port 5500
# Admin → Demand Forecasting → "Run forecast", then Branch & Inventory → "Generate recommendations"

# Mobile: cd cartify-mobile && npx expo start   (Home → ✨ button, or Help Center → Ask Cartify Assistant)
```

The CLIP-based SmartBox check is unrelated; set `AI_VERIFY=off` if you don't need it locally.

## 10. Testing results

All results come from a local MongoDB 7 with the demo data. The LLM agents were tested against a
scripted stand-in for the Claude API (no API key was available in the development environment); see
section 11.

| Suite | Result |
|---|---|
| `npm run test:api`: existing endpoints (catalog, cart via cookie and `X-Session-Id`, wishlist, login and admin checks, order flow, stock decrement, order ownership, returns, cancel restores stock, logout). Run **before and after** the changes. | 44 / 44 passed both times |
| `npm run test:inventory`: forecast run and model selection, views, recommendations, approve/complete/cancel/reject with reservations, validation, adjustments, anomalies, report, admin-only access | 34 / 34 |
| `npm run test:ai-tools`: every agent tool against the API, schema validation, confirmation-only actions, order privacy, customers and guests blocked from inventory tools | 39 / 39 |
| `npm run test:agents`: agent loop end to end (tool calls, blocks, confirm/cancel, double-confirm, cross-user access, invalid tool arguments, loop cap, refusal, provider 500/401/429, inventory agent permissions) and mobile-style requests | 36 / 36 and 8 / 8 |
| `ai-service` unit tests (stockout-aware rates, no train/test overlap, bounds, short history fallback, input validation) | 6 / 6 |
| Browser checks (Playwright): Demand Forecasting, Branch & Inventory (recommendations, agent chat, confirm card), dashboard, store widget on desktop and iPhone size (search → product cards → confirm → cart badge 0 → 1, comparison table) | no console errors from the new code |
| Mobile app: `tsc --noEmit` and `expo lint` | 0 errors (the 1 lint warning is pre-existing in `checkout.tsx`) |

Failure handling was checked too. With the AI service stopped, saved forecasts and inventory rules
still work and the page shows how to start the service. With no API key, the assistant reports
itself as unavailable.

## 11. Known limitations and next steps

- **No live LLM test yet.** The agent code follows the Claude API documentation and passed the
  stand-in tests, but it needs one run with a real `ANTHROPIC_API_KEY` to check answer quality
  (tool choice, wording, Arabic replies). Each chat message costs a few model calls; adjust
  `AI_EFFORT` and the rate limit to control cost.
- **Synthetic data.** All forecast accuracy figures come from simulated sales. Real accuracy will be
  known only after several months of real orders. Yearly seasonality needs about 2 years of history.
- **Branch stock is per product, not per colour,** and is separate from the online store's variant
  stock. Online orders don't take stock from branches. Linking them (for example, fulfilling online
  orders from a branch via `orders.branchId`) is the main next step for branch operations.
- **Network topology between branches is not decided.** The branch module makes no assumptions
  about it; branches are independent stock locations reached through the central API.
- **Approvals use the existing `admin` role.** There is no separate "branch manager" role yet; adding
  one would need a role and branch scope in `auth.js`.
- **Currency:** prices are used exactly as the store lists them (shown as `$`). The assistant does not
  convert EGP budgets; it asks for the budget in the store currency.
- **Product data is thin** (short descriptions, no structured specs such as RAM). The assistant only
  states specs that are in the data, so richer product attributes would make search much better.
- **Daily snapshots** run inside the Node process. On serverless hosting, call
  `POST /inventory/snapshots` from a daily cron job instead.
- **The mobile Assistant screen** passed typecheck and lint but wasn't run on a device or simulator
  here.
