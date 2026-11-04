# Cartify Backend API

REST API for the Cartify e-commerce platform with **smart return box MQTT integration**.

**Stack:** Node.js 18+, Express 5, MongoDB 8, Mongoose, JWT auth, MQTT 5, Cloudinary

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in: DB_URL, JWT_SECRET, email, Cloudinary, MQTT_BROKER_URL

# 3. Seed database (6 categories, 60 products, admin user)
npm run seed

# 4. Start
npm run dev              # development (nodemon)
npm start                # production
```

**Admin credentials:** `admin@cartify.com` / `Admin@12345`

---

## API Endpoints

### Products — `/products`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/products` | Public | List products (search, filter, sort, paginate) |
| GET | `/products/featured` | Public | Featured products |
| GET | `/products/categories` | Public | All distinct categories |
| GET | `/products/brands` | Public | All distinct brands |
| GET | `/products/slug/:slug` | Public | Get by URL slug |
| GET | `/products/:id` | Public | Get by MongoDB ID |
| GET | `/products/:id/reviews` | Public | Paginated reviews |
| POST | `/products` | Admin | Create (multipart) |
| PATCH | `/products/bulk-brand` | Admin | Bulk update by brand |
| PATCH | `/products/bulk-category` | Admin | Bulk update by category |
| PATCH | `/products/:id` | Admin | Update (multipart) |
| DELETE | `/products/:id` | Admin | Delete |

**Query params for `GET /products`:**
```
?page=1&limit=12
?search=headphones          # name, category, brand, description
?category=Electronics
?brand=Sony
?minPrice=50&maxPrice=500
?sort=price_asc|price_desc|newest|rating
?featured=true
?color=Black
```

---

### Categories — `/categories`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/categories` | Public | All active categories |
| GET | `/categories/:slug` | Public | Category + products |
| POST | `/categories` | Admin | Create |
| PATCH | `/categories/:id` | Admin | Update |
| DELETE | `/categories/:id` | Admin | Delete |
| POST | `/categories/sync-counts` | Admin | Recompute product counts |

---

### Users — `/users`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/users/auth` | Public | Login/register (magic-link) |
| POST | `/users/logout` | Public | Clear auth cookie |
| GET | `/users/me` | User | Own profile |
| PATCH | `/users/me` | User | Update profile |
| GET | `/users` | Admin | List all users |
| GET | `/users/:id` | Admin | Get user by ID |
| PATCH | `/users/:id` | Admin | Update user |

**Auth body:**
```json
{ "email": "user@example.com" }
```

---

### Cart — `/cart`

Works for anonymous (sessionId) and authenticated (token) users.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/cart` | Any | Get cart + subtotal + totalQuantity |
| GET | `/cart/quantity` | Any | Get item count only |
| POST | `/cart` | Any | Add item |
| PATCH | `/cart/add-quantity` | Any | +1 quantity |
| PATCH | `/cart/reduce-quantity` | Any | -1 quantity |
| PATCH | `/cart/remove-item` | Any | Remove item |
| PATCH | `/cart/empty` | Any | Clear cart |
| GET | `/cart/all` | Admin | All carts (paginated) |

**Add to cart body:**
```json
{ "productId": "...", "color": "Black", "quantity": 1 }
```

---

### Wishlist — `/wishlist`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/wishlist` | Any | Get wishlist |
| POST | `/wishlist/toggle` | Any | Add/remove item |
| DELETE | `/wishlist/empty` | Any | Clear wishlist |
| DELETE | `/wishlist/item/:productId` | Any | Remove one item |

---

### Orders — `/orders`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/orders/shipping-rates` | Public | Shipping cost map |
| GET | `/orders/my` | Any | Own orders |
| POST | `/orders` | Any | Create order from cart |
| GET | `/orders/:id` | Any* | Get order (owner or admin) |
| GET | `/orders` | Admin | All orders (search, filter) |
| PATCH | `/orders/:id` | Admin | Update order |
| PATCH | `/orders/:id/cancel` | Admin | Cancel + restore stock |

**Create order body:**
```json
{
  "email": "user@example.com",
  "firstName": "Ahmed",
  "lastName": "Hassan",
  "phone": "01012345678",
  "address": "123 Nile Street",
  "city": "Cairo",
  "governorate": "Cairo",
  "paymentMethod": "cash",
  "notes": "Ring doorbell"
}
```

**Valid order statuses:** `placed → confirmed → shipping → delivered` | `cancelled` | `refunded`

---

### Reviews — `/reviews`

All require authentication.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/reviews` | User | Create review |
| PATCH | `/reviews/:id` | User/Admin | Update own review |
| DELETE | `/reviews/:id` | User/Admin | Delete own review |

Reviews are also fetched via `GET /products/:id/reviews`.

**Create review body:**
```json
{
  "productId": "...",
  "rating": 5,
  "title": "Excellent quality",
  "body": "Bought this last week and very happy.",
  "orderId": "..."
}
```

---

## 🆕 Returns & Smart Boxes — `/returns`

### Create Return Request

**POST `/returns`** — Create a return request with a short code.

```bash
curl -X POST http://localhost:3001/returns \
  -H "Content-Type: application/json" \
  -H "Cookie: token=<jwt_token>; sessionId=<session_id>" \
  -d '{
    "orderId": "...",
    "reason": "defective",
    "items": [
      { "productId": "...", "name": "Soundcore Pro Wireless v2", "color": "Black", "quantity": 1 }
    ],
    "notes": "Speaker not turning on"
  }'
```

**Response:**
```json
{
  "msg": "success",
  "returnRequest": {
    "_id": "...",
    "code": "ABC123",
    "status": "pending",
    "expiresAt": "2026-05-07T03:49:21Z",
    "items": [...],
    "reason": "defective",
    "notes": "Speaker not turning on",
    "createdAt": "2026-05-05T03:49:21Z"
  }
}
```

---

### Get My Returns

**GET `/returns/my?page=1&limit=10`** — Paginated list of own return requests.

```bash
curl http://localhost:3001/returns/my \
  -H "Cookie: token=<jwt_token>; sessionId=<session_id>"
```

---

### Get Return by ID

**GET `/returns/:id`** — Ownership checked; admin sees all.

```bash
curl http://localhost:3001/returns/507f1f77bcf86cd799439011 \
  -H "Cookie: token=<jwt_token>"
```

---

### Admin: List All Returns

**GET `/returns?page=1&limit=20&status=pending&search=ABC123`**

```bash
curl http://localhost:3001/returns \
  -H "Cookie: token=<admin_jwt>"
```

**Query params:**
- `status` — `pending`, `completed`, `expired`, `denied`
- `search` — filter by code or reason
- `page`, `limit` — pagination

---

### Admin: Manual Status Override

**PATCH `/returns/:id`**

```bash
curl -X PATCH http://localhost:3001/returns/507f1f77bcf86cd799439011 \
  -H "Content-Type: application/json" \
  -H "Cookie: token=<admin_jwt>" \
  -d '{ "status": "denied" }'
```

---

## 🔌 MQTT Integration — Smart Return Boxes

The backend connects to an MQTT broker and validates return codes sent by physical IoT boxes. This is **zero-configuration** if you disable MQTT (just don't set `MQTT_BROKER_URL`).

### Architecture

```
ESP Device (Box)
    ↓ MQTT publish
    box/{boxId}/request
    { "code": "ABC123" }
    ↑ MQTT subscribe
    box/{boxId}/command
    { "action": "open" | "deny" | "expired" | "used" }
    ↓
Cartify Backend
    ↓ Query MongoDB
    return collection: code = "ABC123"
    ↓ Validate
    Status tree:
      - not found        → action: deny
      - expired          → action: expired
      - not pending      → action: used
      - valid & pending  → action: open (update to completed)
```

### Configuration

Add to `.env`:

```bash
# MQTT Broker (optional — if unset, MQTT is disabled)
MQTT_BROKER_URL=mqtt://localhost:1883

# Optional: authenticated broker
MQTT_USERNAME=user
MQTT_PASSWORD=password

# Optional: TLS/MQTTS
# MQTT_BROKER_URL=mqtts://broker.example.com:8883
# MQTT_CA_CERT_PATH=./certs/ca.crt
```

### Message Flow

#### 1. Box scans return code

**Topic:** `box/{boxId}/request`  
**Payload:**
```json
{ "code": "ABC123" }
```

Example (mosquitto):
```bash
mosquitto_pub -h localhost -t "box/box-001/request" -m '{"code":"ABC123"}'
```

#### 2. Backend validates and responds

**Topic:** `box/{boxId}/command`  
**Payload:**
```json
{ "action": "open" }
```

Possible actions:
- **`open`** — Code is valid and pending. Box should unlock. Return marked `completed`.
- **`deny`** — Code not found in database.
- **`expired`** — Code exists but past `expiresAt` time.
- **`used`** — Code already processed (status is `completed`, `expired`, or `denied`).

#### 3. Backend logs

```
[MQTT] 📥  box/box-001/request → {"code":"ABC123"}
[MQTT] ✅  Box box-001 — code "ABC123" valid → open
[MQTT] 📤  box/box-001/command → {"action":"open"}
```

### Return Code Lifecycle

```
pending ─────────────────────> completed
  ↓ (48h expires)                  ↓
  expired                      (box scanned,
                                marked by MQTT)
  
  ↓ (admin manual)
  denied
```

**Default TTL:** 48 hours from creation (configurable in `return.controller.js` → `CODE_TTL_MS`)

### Error Handling

| Scenario | Log | Box Response |
|----------|-----|--------------|
| Broker unavailable at startup | Warning logged, MQTT disabled | N/A |
| Broker drops mid-operation | Retry every 5s (auto-reconnect) | No message sent |
| Malformed JSON from box | Error logged | `deny` published |
| Missing `code` field | Error logged | `deny` published |
| DB connection fails | Error logged | `deny` published |
| Code not found | Warning logged | `deny` published |

**The box always receives a response or times out gracefully — never hung.**

### Testing

```bash
# Terminal 1: Start the backend
npm run dev

# Terminal 2: Subscribe to responses
mosquitto_sub -h localhost -t "box/+/command"

# Terminal 3: Send a request
mosquitto_pub -h localhost \
  -t "box/test-box/request" \
  -m '{"code":"ABC123"}'

# You should see in Terminal 2:
# {"action":"deny"}  (or "open" if code exists and valid)
```

---

## Response Format

**Success:**
```json
{ "msg": "success", ...data }
```

**Error:**
```json
{ "msg": "error", "err": "Human-readable message" }
```

**Paginated:**
```json
{
  "msg": "success",
  "page": 1,
  "limit": 12,
  "total": 60,
  "totalPages": 5,
  "products": [...]
}
```

---

## Authentication

- **Magic-link:** `POST /users/auth { "email": "..." }` creates user + JWT
- **JWT stored in:** `httpOnly` cookie (`token`), expires in 7 days
- **Anonymous users:** Get `sessionId` cookie — cart & wishlist work without login
- **On login:** Session cart + wishlist merged into user account

---

## File Structure

```
cartify-backend/
├── index.js                         ← Entry point (calls initMqtt)
├── db/
│   ├── connectionDB.js
│   ├── seeder.js
│   └── models/
│       ├── product.model.js
│       ├── category.model.js
│       ├── user.model.js
│       ├── cart.model.js
│       ├── wishlist.model.js
│       ├── order.model.js
│       ├── review.model.js
│       ├── return.model.js          ← NEW: Return requests
│       └── counter.model.js
└── src/
    ├── middleware/
    │   ├── auth.js
    │   ├── session.js
    │   ├── multer.js
    │   └── validation.js            ← Includes createReturnRules
    ├── utils/
    │   ├── error.js
    │   ├── response.js
    │   ├── slug.js
    │   ├── counter.js
    │   ├── shipping.js
    │   ├── email.js
    │   └── cloudinary.js
    └── modules/
        ├── product/
        ├── category/
        ├── user/
        ├── cart/
        ├── wishlist/
        ├── order/
        ├── review/
        ├── return/                   ← NEW: REST API
        │   ├── return.controller.js
        │   └── return.routes.js
        └── mqtt/                     ← NEW: MQTT service
            └── mqtt.service.js
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `MQTT_BROKER_URL not set` | MQTT is disabled — set env var or ignore if not needed |
| Box doesn't receive response | Check broker is running; check firewall; try `mosquitto_sub` to verify connection |
| Code marked `expired` instead of `open` | Check system clock on backend server |
| Subscription fails | Verify `box/+/request` is correct; some brokers require `/` prefix |
| Code not found in DB | Ensure return was created via REST API before box scans |

---

## Security Notes

- ✅ JWT validated on all protected routes
- ✅ Admin-only routes require `role: 'admin'`
- ✅ Ownership checks on /returns/:id (user can only see own)
- ✅ MQTT messages validated: JSON parse errors → deny
- ✅ Code lookup is indexed (fast, no N+1)
- ✅ Stock reservations prevent overselling
- ✅ CORS whitelists frontend origins
- ✅ Passwords bcrypted (admin only, not exposed in API)

---

## Development vs Production

**Development:**
- Node: `npm run dev` (nodemon watches changes)
- DB: MongoDB local or Atlas
- Uploads: Disk storage to `./uploads`
- MQTT: Optional (localhost:1883)

**Production:**
- Node: `npm start`
- DB: MongoDB Atlas
- Uploads: Cloudinary (automatic via multer)
- MQTT: Configured MQTT_BROKER_URL (e.g., HiveMQ, Mosquitto in cloud)

---

## License

MIT
