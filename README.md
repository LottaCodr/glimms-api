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
- **Redis** — on Windows use [Memurai](https://www.memurai.com/) or WSL2 (`sudo apt install redis-server && redis-server`); on macOS `brew install redis && brew services start redis`; or a hosted Redis via `REDIS_URL` in `.env`

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

---

## Testing

```bash
npm test                 # run all tests
npm run test:watch       # watch mode
```

Tests use a real MongoDB instance (the test database is dropped after each run).
