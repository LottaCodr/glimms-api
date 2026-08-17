# glimms-api

> The Glimms backend — a single **Express.js + MongoDB (Mongoose 9)** server handling all API routing, business logic, authentication, real-time WebSocket events, and the background AI pipeline worker.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + TypeScript 5 |
| Framework | Express.js 4 |
| Database | **MongoDB 7 via Mongoose 9.1.3** |
| Cache / Queue | Redis 7 + BullMQ |
| Real-time | Socket.IO |
| Storage | AWS S3 |
| Payments | Stripe |
| Push notifications | Firebase Admin (FCM / APNs) |
| Email | SendGrid |
| Style vectors | Pinecone |

---

## Why MongoDB + Mongoose?

Glimms data has naturally variable shapes — catalog items have different attributes depending on whether they're wardrobe, room, or garden items; design results embed LLM outputs, mockup URLs, and item references that evolve over time. MongoDB's document model handles this cleanly without migration pain.

Mongoose 9.1.3 specifically:
- No more deprecated `useNewUrlParser` / `useUnifiedTopology` flags
- `strictQuery` defaults to `false`
- TTL indexes handle refresh token expiry automatically
- `select: false` on `passwordHash` ensures it's never accidentally leaked

---

## Project Structure

```
src/
├── config/          — Zod-validated environment config
├── lib/             — Singleton clients: Mongoose, Redis, S3, BullMQ queues
├── models/          — All Mongoose schemas and models
│   ├── User.ts
│   ├── RefreshToken.ts
│   ├── UserPreferences.ts
│   ├── Subscription.ts
│   ├── CatalogItem.ts
│   ├── DesignJob.ts
│   └── SavedDesign.ts  (+ DeviceToken)
├── middleware/       — Auth, rate limiting, validation, error handling
├── routes/          — Express route handlers (thin — delegate to services)
├── services/        — All business logic (auth, users, catalog, designs, ...)
├── workers/         — BullMQ worker: drives the 8-step AI pipeline
├── websocket/       — Socket.IO server: pushes job progress to mobile
├── app.ts           — Express app factory
└── server.ts        — Bootstrap: connect DB → start HTTP + WS + worker
```

---

## Quick Start

### Option A — Docker (recommended)

```bash
cp .env.example .env
# No other config needed for local dev
docker-compose up
```

Starts: **glimms-api** on port 4000, **MongoDB** on 27017, **Redis** on 6379.

Optional dev tools (Mongo Express UI):
```bash
docker-compose --profile dev-tools up
# Mongo Express at http://localhost:8082  (admin / glimms)
```

### Option B — Local

```bash
cp .env.example .env
npm install

# Start infra only (MongoDB + Redis) — the API will NOT start without both running
npm run services:up
# equivalent to: docker compose up -d mongo redis

# Run with hot reload
npm run dev
```

No Docker on your machine? Get MongoDB and Redis some other way before running `npm run dev`:
- **MongoDB** — install [MongoDB Community Server](https://www.mongodb.com/try/download/community) locally, or use a free Atlas cluster (`MONGODB_URI` in `.env`)
- **Redis** — on Windows use [Memurai](https://www.memurai.com/) or WSL2 (`sudo apt install redis-server && redis-server`); on macOS `brew install redis && brew services start redis`; or a hosted Redis via `REDIS_URL` in `.env`. BullMQ requires the Redis eviction policy to be `noeviction`; for a local server, set it with `redis-cli CONFIG SET maxmemory-policy noeviction` (and persist it in your Redis configuration).

---

## API Reference

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Login, get token pair |
| POST | `/api/auth/refresh` | — | Rotate refresh token |
| POST | `/api/auth/logout` | — | Revoke refresh token |

### Users
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users/me` | ✅ | Get own profile |
| PATCH | `/api/users/me` | ✅ | Update name / avatar |
| DELETE | `/api/users/me` | ✅ | Deactivate account |
| GET | `/api/users/me/preferences` | ✅ | Get style preferences |
| PUT | `/api/users/me/preferences` | ✅ | Save style preferences |

### Scans & Designs
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/scans/upload` | ✅ + quota | Upload images → start AI pipeline |
| GET | `/api/designs/jobs` | ✅ | List design jobs |
| GET | `/api/designs/jobs/:id` | ✅ | Get job status + result |
| GET | `/api/designs/saved` | ✅ | Saved designs |
| POST | `/api/designs/saved` | ✅ | Save a design |
| PATCH | `/api/designs/saved/:id/favorite` | ✅ | Toggle favourite |

### Catalog
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/catalog` | ✅ | List items (filter by vertical/category/tag) |
| GET | `/api/catalog/:id` | ✅ | Get single item |
| POST | `/api/catalog` | ✅ | Add item manually |
| PATCH | `/api/catalog/:id` | ✅ | Update tags / attributes |
| DELETE | `/api/catalog/:id` | ✅ | Soft-delete item |

### Other
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/subscriptions/me` | ✅ | Current subscription |
| POST | `/api/subscriptions/checkout` | ✅ | Create Stripe checkout |
| POST | `/api/subscriptions/webhook` | Stripe | Stripe webhook |
| POST | `/api/notifications/device-token` | ✅ | Register push token |
| POST | `/api/analytics/track` | Optional | Track event |

---

## WebSocket

Connect to `ws://localhost:4000` with `{ auth: { token: "<jwt>" } }`.

```js
// Subscribe to a job's progress
socket.emit('subscribe:job', jobId)

// Listen for updates
socket.on('job:update',   data => { /* { status, step, progress } */ })
socket.on('job:complete', data => { /* full result with designs */ })
socket.on('job:failed',   data => { /* { error } */ })
```

---

## AI Pipeline (design worker)

When a scan is uploaded, the BullMQ worker runs 8 steps in sequence:

```
1. Object detection     → glimms-ai :8001  (YOLOv8)
2. Attribute extraction → glimms-ai :8002  (CLIP + colour + texture)
3. Embedding upsert     → glimms-ai :8003  (Pinecone — non-blocking)
4. Catalog save         → MongoDB           (detected items saved)
5. Permutations         → glimms-ai :8004  (combinatorics + filters)
6. LLM reasoning        → glimms-ai :8005  (GPT-4o / Claude)
7. Mockup compositor    → glimms-ai :8006  (Pillow + S3)
8. Complete             → MongoDB + WS push + push notification
```

Each step's URL is configurable via `.env`. If an AI service is down, the worker retries up to 3 times with exponential backoff.

---

## Connecting to the AI services

The AI tier can be deployed in either of two shapes, and the API supports both.

### A — Single gateway (hosted deployment)

All eight services sit behind one origin and are addressed by path prefix
(`/object-detection/…`, `/quality-guard/…`). Set one variable:

```bash
AI_GATEWAY_URL=https://glimms-ai.onrender.com
```

The API derives every service URL from it — `AI_GATEWAY_URL` +
`/<service-name>` — so `qualityGuard` resolves to
`https://glimms-ai.onrender.com/quality-guard` and its `POST /check` lands on
`https://glimms-ai.onrender.com/quality-guard/check`.

Two settings usually belong with it on a free hosting tier:

```bash
AI_TIMEOUT_MULTIPLIER=5   # instances sleep when idle and take ~30-60s to wake
AI_ALLOW_DEGRADED=true    # lightweight build runs offline fallbacks (see below)
```

### B — One URL per service (docker-compose / k8s)

```bash
AI_OBJECT_DETECTION_URL=http://object-detection:8001
AI_ATTRIBUTE_EXTRACTOR_URL=http://attribute-extractor:8002
# …
```

Resolution order per service: **`AI_<SERVICE>_URL` → `AI_GATEWAY_URL` →
`http://localhost:800X`.** A per-service value always wins, so you can run
seven services through a gateway and pin one elsewhere. Blank values count as
unset, and trailing slashes are trimmed.

### Verifying the connection

```bash
AI_GATEWAY_URL=https://glimms-ai.onrender.com npm run ai:check
```

Prints the resolved base URL for each service, how it was resolved, and its
`/health` response; exits non-zero if any service is unreachable, so it can gate
a deploy. At runtime the same information is served by `GET /health/ready`.

### `ok` vs `degraded` vs `unavailable`

`GET /health/ready` classifies each service:

| Status | Meaning |
|---|---|
| `ok` | Reachable, running its real backend |
| `degraded` | Reachable, but on a fallback backend — `model_loaded:false`, in-memory vectors instead of Pinecone, offline LLM |
| `unavailable` | Not reachable |

The lightweight all-in-one image deliberately runs deterministic offline
fallbacks (no torch/CLIP/YOLO/rembg/Pinecone), so it reports `degraded` for
object-detection and embedding-engine and `/health/ready` returns **503** by
default. Set `AI_ALLOW_DEGRADED=true` to treat those as ready — an unreachable
service still fails readiness. Build the per-service images
(`docker compose build`) for the full models.

> The frontend must never call the AI services directly — only this API does.

---

## Mongoose Models

| Model | Collection | Key indexes |
|---|---|---|
| `User` | `users` | `email` (unique), `tier` |
| `RefreshToken` | `refreshtokens` | `tokenHash` (unique), TTL on `expiresAt` |
| `UserPreferences` | `userpreferences` | `userId` (unique) |
| `Subscription` | `subscriptions` | `userId` (unique), `stripeCustomerId` |
| `CatalogItem` | `catalogitems` | `userId+vertical`, `userId+isActive` |
| `DesignJob` | `designjobs` | `userId+status`, `userId+createdAt` |
| `SavedDesign` | `saveddesigns` | `userId`, `userId+isFavorite` |
| `DeviceToken` | `devicetokens` | `token` (unique), `userId` |

---

## Environment Variables

See `.env.example` — all variables are documented inline.

Minimum required for local dev:
```
MONGODB_URI=mongodb://localhost:27017/glimms
REDIS_URL=redis://localhost:6379
JWT_SECRET=<32+ chars>
REFRESH_TOKEN_SECRET=<32+ chars>
```

To point at the hosted AI tier instead of local AI containers, add
`AI_GATEWAY_URL` — see [Connecting to the AI services](#connecting-to-the-ai-services).

---

## Testing

```bash
npm test                 # run all tests
npm run test:watch       # watch mode
```

Tests use a real MongoDB instance (the test database is dropped after each run).
