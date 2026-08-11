# Glimms Frontend Integration Guide
> How to implement the frontend (Web + Mobile) against `glimms-api`

**Backend:** `glimms-api` — Express 4 + Mongoose 9 + Redis/BullMQ + Socket.IO + Stripe + Firebase  
**API Base URL:** `http://localhost:4000` (dev) — `https://api.glimms.ai` (prod)  
**Last updated:** 2026-08-11 — branch `arena/019ff0c9-glimms-api`

---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [Environments & CORS](#2-environments--cors)
3. [Authentication (JWT + Refresh)](#3-authentication)
4. [Core Client: axios/fetch with Interceptors](#4-core-client)
5. [Error Handling & Codes](#5-error-handling)
6. [Health & Rate Limits](#6-health--rate-limits)
7. [Users & Preferences](#7-users--preferences)
8. [Scans — The Entry Point (Upload → Design Pipeline)](#8-scans)
9. [Design Jobs & WebSocket Realtime](#9-design-jobs--realtime)
10. [Saved Designs](#10-saved-designs)
11. [Catalog](#11-catalog)
12. [Subscriptions & Stripe](#12-subscriptions)
13. [Push Notifications](#13-push-notifications)
14. [Analytics](#14-analytics)
15. [Types for Frontend](#15-types)
16. [Screens / Flows to Build](#16-screens--flows)
17. [State & Caching Recommendations](#17-state--caching)
18. [Web vs Mobile Differences](#18-web-vs-mobile)
19. [Security Checklist](#19-security-checklist)
20. [Example: Full Scan Flow (React + Expo)](#20-example-full-scan-flow)
21. [What Not to Build (Backend-Only)](#21-what-not-to-build)
22. [Appendix: All Endpoints Reference](#22-appendix)

---

## 1. Overview & Architecture

```
[Expo Mobile (exp://)] ─┐
                         ├─► https://api.glimms.ai  ──► MongoDB 7
[Web Dashboard (Next)] ──┘               │
                                         ├─► Redis + BullMQ (queue)
                                         ├─► S3 (images)
                                         ├─► Socket.IO (ws://)
                                         ├─► 6× Python AI services (8001-8008)
                                         ├─► Stripe (payments)
                                         ├─► Firebase (push)
                                         └─► OpenWeather + Pinecone
```

* Single API server (`src/app.ts`) serves **all** clients. No separate BFF.
* Auth is **stateless JWT (15m)** + **opaque refresh token (7d, SHA-256 hashed in MongoDB, TTL)**. You store both client-side and rotate on every `refresh`.
* Image-heavy writes go through `multipart/form-data` → S3 → BullMQ job → 6-step AI pipeline → Socket.IO push → `job:complete`.
* CORS allows `http://localhost:3000` and `exp://*` in dev; prod allowlist via `ALLOWED_ORIGINS`.

---

## 2. Environments & CORS

### Frontend env variables

Create `.env` (web) and `app.config.js` `extra` (Expo):

```bash
# .env — Web (Next.js / Vite)
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000

# Expo — app.json / app.config.js
# EXPO_PUBLIC_API_URL is exposed to JS; use Constants.expoConfig.extra.apiUrl
EXPO_PUBLIC_API_URL=http://192.168.1.10:4000  # your LAN IP for physical device
EXPO_PUBLIC_WS_URL=ws://192.168.1.10:4000
```

> **Physical device caveat:** `localhost` from phone resolves to phone itself. Use your laptop LAN IP (`ifconfig` → `192.168.x.x`) and add it to backend `ALLOWED_ORIGINS` (`ALLOWED_ORIGINS=http://192.168.1.10:3000,exp://192.168.1.10:19000`). In production, set `ALLOWED_ORIGINS=https://app.glimms.ai,https://www.glimms.ai`.

### CORS behavior (backend `src/app.ts`)

```ts
origin: (origin, cb) => {
  if (!origin || allowedOrigins.includes(origin)) cb(null, true);
  else cb(new Error(`CORS: origin ${origin} not allowed`));
}
```

* `!origin` → native mobile apps, `curl`, Postman automatically pass.
* Web must send `Origin` header — must be in allowlist. Handle the CORS error as a 500 with `error: "CORS: origin ... not allowed"` and show a config hint.

### Health

```http
GET /health
# 200 { status:"ok", service:"glimms-api", env:"development", checks:{mongodb:"ok", redis:"ok"}, uptime:123, ts:"..." }
# 503 { status:"degraded", checks:{mongodb:"ok", redis:"unavailable"} }
```

Use for splash-screen readiness poll. Degraded still serves read paths but scans may queue.

---

## 3. Authentication

### 3.1 Endpoints

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| `POST` | `/api/auth/register` | — | `{ email, password (min 8), name? }` | `201 { accessToken, refreshToken, expiresIn: 900 }` |
| `POST` | `/api/auth/login` | — | `{ email, password }` | `200 { accessToken, refreshToken, expiresIn }` |
| `POST` | `/api/auth/refresh` | — | `{ refreshToken }` | `200 { accessToken, refreshToken, expiresIn }` — **rotates** old token |
| `POST` | `/api/auth/logout` | — | `{ refreshToken }` | `200 { message:"Logged out successfully" }` |

All validation is Zod; on 400 you get `{ error:"Validation failed", details:[{field,message}], code:"VALIDATION_ERROR" }`. On duplicate: `409 { code:"CONFLICT" }`.

### 3.2 Tokens

* `accessToken`: JWT `15m` default (`JWT_EXPIRES_IN` env). Payload `{ sub: userId (ObjectId string), email, tier:"free"|"premium"|"pro" }`, signed with `JWT_SECRET` (min 32 chars).
* `refreshToken`: raw opaque `hex(48 bytes)` = 96-char hex. Stored as `SHA256` in `RefreshToken` collection with `expiresAt` (`7d`) TTL. **Single-use**: each `refresh` deletes old hash and issues new pair. Re-using old `refreshToken` → `401 { code:"UNAUTHORIZED" }`.
* `expiresIn` is **seconds** until access token expiry (e.g., `900`). Use to schedule proactive refresh.

### 3.3 Where to Store (critical)

| Platform | Access Token | Refresh Token | Why |
|----------|--------------|---------------|-----|
| **Expo / React Native** | `expo-secure-store` (`SecureStore`) | `SecureStore` | Encrypted Keychain/Keystore, survives reinstall? No — handle re-login. Never `AsyncStorage`. |
| **Web (Next.js)** | In-memory (`React state` / `Zustand`) + `httpOnly` cookie if you control BFF | `httpOnly` `Secure` cookie (`SameSite=Lax`) via backend `Set-Cookie` **or** `localStorage` as fallback (XSS risk) | If no BFF, short-lived in-memory + `localStorage` for refresh is common but document XSS risk. Prefer `httpOnly`. |

This backend **does not set cookies** — it returns JSON. So frontend **must** implement storage client-side. For web, you can optionally add a thin BFF that converts JSON tokens to `httpOnly` cookies, but out of scope for MVP — document the tradeoff.

### 3.4 Auth Flows

**Register → Auto-login:**
```ts
const { accessToken, refreshToken } = await api.post('/api/auth/register', { email, password, name });
await SecureStore.setItemAsync('accessToken', accessToken);
await SecureStore.setItemAsync('refreshToken', refreshToken);
// navigate to Onboarding (preferences)
```

**Login:**
```ts
const res = await api.post('/api/auth/login', { email, password });
```

**Remember me:** Both tokens persist; on app launch, try `getCurrentUser()` — if 401, attempt refresh before showing Login.

**Logout:**
```ts
const rt = await SecureStore.getItemAsync('refreshToken');
await api.post('/api/auth/logout', { refreshToken: rt }); // best-effort
await SecureStore.deleteItemAsync('accessToken');
await SecureStore.deleteItemAsync('refreshToken');
```

> If backend email is uppercase, it **lowercases** on save (`User.email` `lowercase:true`). Login must also lower-case client-side or rely on backend's `toLowerCase()` — both work, but normalize display.

### 3.5 User object shape (`GET /api/users/me`)

```ts
type User = {
  id: string; // _id → id via toJSON transform
  email: string;
  name: string | null;
  avatarUrl: string | null;
  tier: "free" | "premium" | "pro";
  isActive: boolean;
  createdAt: string; // ISO
  updatedAt: string;
  // passwordHash is NEVER returned (select:false + transform delete)
}
```

---

## 4. Core Client

### 4.1 Recommended: axios with interceptors (works web + RN)

```ts
// lib/api.ts
import axios from "axios";
import * as SecureStore from "expo-secure-store"; // or localStorage for web
import Constants from "expo-constants";

const API_URL = process.env.EXPO_PUBLIC_API_URL
  ?? Constants.expoConfig?.extra?.apiUrl
  ?? "http://localhost:4000";

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 20000,
  headers: { "Content-Type": "application/json" },
});

// Request: attach access token
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync("accessToken");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response: handle 401 → refresh once → retry
let isRefreshing = false;
let failedQueue: Array<{ resolve: Function; reject: Function }> = [];

function processQueue(error: any, token: string | null = null) {
  failedQueue.forEach(p => error ? p.reject(error) : p.resolve(token));
  failedQueue = [];
}

api.interceptors.response.use(
  r => r,
  async (error) => {
    const original = error.config as any;
    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }
      original._retry = true;
      isRefreshing = true;
      try {
        const rt = await SecureStore.getItemAsync("refreshToken");
        if (!rt) throw error;
        const { data } = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken: rt });
        await SecureStore.setItemAsync("accessToken", data.accessToken);
        await SecureStore.setItemAsync("refreshToken", data.refreshToken);
        processQueue(null, data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch (e) {
        processQueue(e, null);
        await SecureStore.deleteItemAsync("accessToken");
        await SecureStore.deleteItemAsync("refreshToken");
        // redirect to login
        // router.replace("/login");
        return Promise.reject(e);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  }
);
```

**Web alternative (fetch):** same logic, but use `localStorage` and `fetch` wrapper.

### 4.2 Request ID

Backend `pino-http` logs `req.id`. Frontend should send `X-Request-Id: uuid()` on every request for cross-service tracing (optional but recommended for debugging AI pipeline failures).

```ts
import { v4 as uuid } from "uuid";
api.interceptors.request.use(async (c) => { c.headers["X-Request-Id"] = uuid(); return c; });
```

---

## 5. Error Handling

All errors are JSON:

```json
{ "error": "Human message", "code": "MACHINE_CODE", "details": [...] }
```

| Status | Code | When | Frontend action |
|--------|------|------|-----------------|
| 400 | `VALIDATION_ERROR` | Zod fail | Show `details[].field: message` under inputs. |
| 400 | `BAD_REQUEST` | Custom | Toast `error`. |
| 401 | `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `UNAUTHORIZED` | No/invalid JWT, refresh reuse, wrong password | Trigger refresh flow; if refresh fails, go to login. |
| 403 | `FORBIDDEN` | Wrong owner (`catalog findOne` not yours) | Show “Not yours” state, refetch list. |
| 403 | `UPGRADE_REQUIRED` + `{ yourTier, upgradeUrl }` | `requireTier` guard (future premium-only routes) | Show paywall CTA `→ upgradeUrl`. |
| 404 | `NOT_FOUND` | Bad ID | Show empty state. |
| 409 | `CONFLICT` / `DUPLICATE_KEY` | Duplicate email | Inline field error “Email already registered”. |
| 429 | `RATE_LIMITED` / `AUTH_RATE_LIMITED` | `generalLimiter` 100/15m, `authLimiter` 10/15m | Show countdown from `Retry-After` header. |
| 429 | `SCAN_LIMIT_REACHED` + `{ scansUsed, limit, tier, resetsAt }` | Daily scan quota (`free 10`, `premium 100`, `pro ∞`) | Show “Daily limit reached — 10/10 — resets tomorrow 23:59” + upsell. |
| 413 | `FILE_ERROR` | Multer `10MB` or `5 files` exceeded | `File too large` toast. |

**Scan-limit headers** (on every `POST /scans/upload` attempt, even on success):
```
X-Scan-Count-Today: 3
X-Scan-Limit: 10
X-Scan-Tier: free
```
Display as progress pill: `3 / 10 scans today`.

---

## 6. Health & Rate Limits

* Call `GET /health` on splash and every 30s background poll.
* Polar: `generalLimiter` is Redis-backed (`100 req / 15m` per IP). For mobile NAT (many users same IP) — consider adding `keyGenerator: userId ?? ip` on frontend-relevant routes if backend allows override (currently IP-only, so advise backend to switch to `userId` for authed routes — already noted in audit).
* `authLimiter`: 10 attempts per IP/15m — show “Too many attempts — try in 15 minutes” after 429 and disable button with timer.

---

## 7. Users & Preferences

### Endpoints

```http
GET    /api/users/me                  → User (requireAuth)
PATCH  /api/users/me                  → { name?, avatarUrl? (url) } (validate)
DELETE /api/users/me                  → { message:"Account deactivated" } (soft, isActive false)
GET    /api/users/me/preferences      → UserPreferences | {}
PUT    /api/users/me/preferences      → { occupation?, styleGoals?[], occasions?[], culturalCtx?, location?{lat, lon, city?, country?} }
```

### Preferences model

```ts
type UserPreferences = {
  id: string;
  userId: string;
  occupation: string | null;   // e.g., "designer", "student"
  styleGoals: string[];        // ["look professional","be comfortable"]
  occasions: string[];         // ["work","casual","wedding"]
  culturalCtx: string | null;  // "west_africa", "global"
  location: { lat:number, lon:number, city?:string, country?:string } | null;
  createdAt: string; updatedAt: string;
}
```

### Implementation notes

* Call `PUT /preferences` **after onboarding questionnaire** (occupation, style goals, occasions, location permission). Location is used for climate-aware designs (weather via OpenWeather). If user denies location, omit `location` — backend defaults climate to `{temp:22, condition:"clear"}`.
* `PUT` is **upsert** (`findOneAndUpdate upsert:true`) — safe to call multiple times; it merges.
* Avatar upload: frontend must upload image to S3 first? Current backend `PATCH /users/me` expects `avatarUrl: url` (already hosted). So implement: pick image → `POST` to `S3` direct or via backend `POST /scans/upload` is only for wardrobe scans — not avatars. For MVP, store avatar as URL from Expo `ImagePicker` uploaded to S3 via presigned flow or just store `data:`? Better to add a dedicated `POST /users/me/avatar` later; for now, accept any https URL and skip upload.

```ts
// Update profile
await api.patch('/api/users/me', { name: "Ada", avatarUrl: "https://..." });
// Save preferences
await api.put('/api/users/me/preferences', {
  occupation: "designer",
  styleGoals: ["minimalist"],
  occasions: ["work"],
  culturalCtx: "west_africa",
  location: { lat: 6.5, lon: 3.3, city: "Lagos", country: "Nigeria" }
});
```

---

## 8. Scans — The Entry Point (Upload → Design Pipeline)

> **Guide note (§3):** The backend now implements **both** the recommended `v1/design-sessions` presigned flow (private S3, no proxy) **and** the legacy `POST /api/scans/upload` FormData proxy for backward compatibility. **New frontend code must use `v1/design-sessions`** — the `FormData` path is deprecated, proxies large bodies through the API process, and will be removed. The dependency graph per guide §3.3 is: `quality + context + detection` in parallel → `attributes` → `permutations + embeddings` → `reasoning` → `mockups`.

### 8A. Recommended: `v1/design-sessions` — presigned direct-to-S3 (per implementation guide §3.1-§3.3)

**Auth:** `requireAuth` + `scanLimiter` (same quotas: free 10/d, premium 100, pro ∞)

#### Step 1 — Create session + upload plan

```http
POST /v1/design-sessions
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "vertical": "wardrobe",
  "occasion": "work",
  "culture": "south asian",
  "climate": { "temperature_c": 29, "humidity": 78 },
  "preferences": { "styles": ["minimalist"], "excluded_labels": ["shorts"], "coverage": "user preference" },
  "imageCount": 3
}
→ 201
{
  "session_id": "665a1b...",
  "status": "created",
  "upload_urls": [
    {
      "image_id": "img_abc123",
      "object_key": "users/usr_123/sessions/665a1b/images/img_abc123/source.png",
      "upload_url": "https://glimms-images.s3.amazonaws.com/...?X-Amz-Signature=...&Expires=900",
      "expires_at": "2026-08-11T14:00:00Z"
    }
  ],
  "correlationId": "cor_..."
}
```

* `vertical` must be `wardrobe|room|garden`. Other fields are stored as `inputContext` (user explicit, not inferred — per guide §3.1). Use opaque IDs from backend — never let client choose `object_key`.
* `imageCount` (1-5) controls how many presigned PUT URLs are issued — frontend must request exact count it intends to upload.
* `upload_url` is a **short-lived presigned PUT** (900s default, `S3_PRESIGN_EXPIRY_SECONDS`). Client has 15 min to `PUT`.

#### Step 2 — Upload directly to S3 (client → S3, bypassing backend)

```ts
// After POST /v1/design-sessions
const { session_id, upload_urls } = await api.post("/v1/design-sessions", {
  vertical: "wardrobe", occasion: "work", culture: "south asian",
  climate: { temperature_c: 29, humidity: 78 },
  preferences: { styles: ["minimalist"] }, imageCount: files.length
}).then(r=>r.data);

await Promise.all(upload_urls.map(async ({ upload_url, object_key }, i) => {
  const file = files[i];
  // Detect real MIME (jpeg|png|webp only — guide §3.2), 15 MB max
  if (!["image/jpeg","image/png","image/webp"].includes(file.type)) throw new Error("Invalid type");
  if (file.size > 15*1024*1024) throw new Error("File too large");

  const res = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": file.type }, // must match presigned ContentType
    body: file, // Blob/File — do NOT JSON-encode
  });
  if (!res.ok) throw new Error(`S3 upload failed ${res.status}`);
}));

```

*Do not* send `Authorization` to S3 — presigned URL already contains signature. Do not send `X-Request-Id`.
* Frontend **must not call** AI services (`http://localhost:8001`) — only backend does via private DNS (`http://object-detection:8001`, etc. per guide §4).

#### Step 3 — Complete upload & enqueue

```http
POST /v1/design-sessions/{session_id}/images/complete
Authorization: Bearer ...
{ "image_ids": ["img_abc123", "img_def456"] }
→ 200 { "session_id": "...", "status": "queued", "image_count": 2, "message": "Uploads verified — analysis queued" }
```

* Backend verifies each `image_id` belongs to session, checks `HeadObject` exists, validates MIME/dimensions server-side, denies `..`/`//` path traversal, enforces `users/<userId>/sessions/<sessionId>/` prefix (§9 security).
* On success, enqueues `design.analysis.requested` (BullMQ) with `correlationId` and `X-Correlation-ID` headers to AI services.
* Errors: `400 image_ids not found`, `400 Image not uploaded yet`, `400 Invalid MIME`, `400 Session is queued` (already completed), `429 SCAN_LIMIT_REACHED`.

#### Step 4 — Read progress (§3.4) — polling *or* WebSocket

```http
GET /v1/design-sessions/{session_id}
→ 200 {
  "session_id": "...",
  "status": "reasoning", // created|uploading|queued|quality_review|detecting|extracting|permuting|embedding|reasoning|composing|completed|failed|cancelled
  "vertical": "wardrobe",
  "progress": 75, // 0-100
  "steps": { "quality":"completed", "detection":"completed", "attributes":"completed", "context":"completed", "permutations":"completed", "embeddings":"completed", "reasoning":"running", "mockups":"pending" },
  "designs": [], // populated at completed
  "warnings": [],
  "artifacts": [],
  "error": null
}
```

Use for polling (`2s` interval) *or* prefer WS `subscribe:session` (next section). Client must handle reconnect — status is persisted, so resume from fetched status.

---

### 8B. Legacy: `POST /api/scans/upload` — multipart/form-data (deprecated — proxies through API)

> Kept for backward compat with `docs/FRONTEND_INTEGRATION.md` v1. It **violates** guide §3.2 ("backend should not proxy large image bodies") and uploads via `multipart/form-data` → backend `sharp` → S3 `PutObject`. Prefer 8A for all new code. It will return `202` immediately after S3 upload, but bypasses presigned verification and is removed in next major.

**Auth:** `requireAuth` + `scanLimiter`  
**Limits:** `5` images max, `10 MB` each, mime `jpeg|jpg|png|webp` (backend `multer.memoryStorage()`)

**Form fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `images` | `File[]` (field name `images`) | ✅ 1-5 | Key must be `images` (backend `uploadMiddleware.array('images',5)`). |
| `vertical` | `"wardrobe" | "room" | "garden"` | ✅ | |
| `occasion` | `string` | — | e.g., `"work"`, `"casual"` — enriches context. |
| `occupation` | `string` | — | Duplicates preferences but allows per-scan override. |
| `culturalCtx` | `string` | — | e.g., `"west_africa"` |
| `lat` | `number` | — | If present, `lon` required → builds climate context. |
| `lon` | `number` | — | |

**Frontend building of form:**

```ts
// React Native (Expo) — pick with expo-image-picker
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";

async function uploadScan(vertical: Vertical, files: ImagePicker.ImagePickerAsset[]) {
  const { status } = await Location.requestForegroundPermissionsAsync();
  let coords: { lat?: number; lon?: number } = {};
  if (status === "granted") {
    const loc = await Location.getCurrentPositionAsync({});
    coords = { lat: loc.coords.latitude, lon: loc.coords.longitude };
  }

  const form = new FormData();
  files.slice(0, 5).forEach((asset, i) => {
    // RN FormData needs uri + name + type
    form.append("images", {
      uri: asset.uri,
      name: `scan_${i}.jpg`,
      type: asset.mimeType ?? "image/jpeg",
    } as any);
  });
  form.append("vertical", vertical);
  form.append("occasion", "casual");
  form.append("occupation", "designer");
  // if you have location:
  if (coords.lat) {
    form.append("lat", String(coords.lat));
    form.append("lon", String(coords.lon));
  }

  const res = await api.post("/api/scans/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 60_000, // uploads + sharp + S3 can be slow
  });
  return res.data; // { jobId, status:"pending", estimatedSeconds, qualityWarning? }
}
```

**Web (browser) variant:**

```ts
const form = new FormData();
Array.from(input.files!).slice(0,5).forEach(f => form.append("images", f));
form.append("vertical", vertical);
```

**Responses:**

* `202 Accepted` (success):
  ```json
  {
    "jobId": "665a...",
    "status": "pending",
    "estimatedSeconds": 15,
    "qualityWarning": "Image quality is low — try better lighting" // optional, only if qualityGuard fails
  }
  ```
  Show `qualityWarning` as non-blocking yellow banner — “We’ll still process, but retake in brighter light for best results” — but proceed to job tracking.

* `400` `{ error:"At least one image is required", code:"NO_FILES" }` — no files.
* `400` `{ error:"Invalid scan parameters", details:{...} }` — Zod on `vertical` enum.
* `401` — not authed.
* `429` `{ code:"SCAN_LIMIT_REACHED", scansUsed:10, limit:10, tier:"free", resetsAt:"2026-08-11T23:59:59Z" }` — daily quota exhausted. Show paywall.
* `429` with `X-Scan-*` headers — display remaining.

**Backend processing (what happens next):**
1. `sharp` rotates EXIF, resizes `2048×2048`, `jpeg 88%`, strips metadata.
2. Upload to S3 `uploads/<userId>/<ts>-<rand>.jpg`.
3. Optional `POST http://quality-guard:8007/check` (base64 of first image) — non-fatal.
4. Creates `DesignJob { status:"pending", imageKeys:[...], contextData:{climate, occasion, ...} }`.
5. Enqueues BullMQ `glimms:design-pipeline` with `priority` (`pro:1`, `premium:5`, `free:10`).
6. Returns `202`.

You **must not** poll `GET /jobs/:id` — use WebSocket instead (next section).

---

## 9. Design Jobs & Realtime

### REST

```http
GET /api/designs/jobs?page=1&limit=20
→ { jobs:[{id, vertical, status, createdAt, completedAt}], total, page, limit, totalPages }

GET /api/designs/jobs/:id
→ DesignJob { id, userId, vertical, status:"pending"|"processing"|"completed"|"failed",
              imageKeys:[], contextData:{climate,occasion,culturalCtx,constraints},
              result: null | { designs:[...], vertical, itemCount, designCount, generatedAt },
              errorMsg: string|null, completedAt, createdAt, updatedAt }

# Note: result is only populated when status==="completed"
```

**Polling fallback:** If WebSocket disconnected, `GET /jobs/:id` every 3s until `completed`/`failed`. But prefer WS.

### WebSocket — Socket.IO (jobs + v1 sessions)

* **URL:** same as API (`ws://localhost:4000` dev, `wss://api.glimms.ai` prod). Share HTTP server. Frontend must use **relative** `WS_URL` from backend env — never `http://localhost:8001` (guide §4: "frontend code must use relative backend URLs, for example `/v1/design-sessions`, never `http://localhost:8001`").
* **Transports:** `websocket` + `polling`.
* **Auth:** `handshake.auth.token` (mobile) **or** `Authorization: Bearer` header. Backend verifies `jwt.verify(token, JWT_SECRET)`. On failure → `connect_error` `Authentication token required` / `Invalid or expired token`.
* **Rooms (legacy jobs):** `job:${jobId}` — one room per job, user must **own** job (backend checks `DesignJob.userId === socket.data.user.sub`, returns `error {message:"Not authorized for this job"}` if not).
* **Rooms (v1 sessions — preferred per guide §3.4):** `session:${sessionId}` (also aliased `job:${sessionId}` for compat). Subscribe via `subscribe:session` or `subscribe:design-session`. Backend checks `DesignSession.userId`. Progress payloads are identical but also emit `session:update` with `{ session_id, status, progress, steps, warnings }` for the new status model.

#### Frontend implementation (React / Expo)

```ts
// lib/socket.ts
import { io, Socket } from "socket.io-client";
import * as SecureStore from "expo-secure-store";

let socket: Socket | null = null;

export async function getSocket(): Promise<Socket> {
  if (socket?.connected) return socket;
  const token = await SecureStore.getItemAsync("accessToken");
  const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? "http://localhost:4000";
  socket = io(WS_URL, {
    auth: { token },
    transports: ["websocket", "polling"],
    timeout: 10_000,
  });

  socket.on("connect", () => console.log("WS connected", socket!.id));
  socket.on("connect_error", (err) => console.warn("WS error", err.message));
  socket.on("disconnect", (reason) => console.log("WS disconnect", reason));
  return socket;
}

// In ScanProgressScreen:
export function useDesignJob(jobId: string) {
  const [job, setJob] = useState<DesignJob | null>(null);
  const [progress, setProgress] = useState({ step:"detecting", progress:10, status:"pending" });

  useEffect(() => {
    let s: Socket;
    (async () => {
      s = await getSocket();
      s.emit("subscribe:job", jobId);
      s.on("subscribed", ({ jobId }) => console.log("subscribed", jobId));
      s.on("job:update", (data) => {
        // { status:"processing", step:"detecting"|"extracting"|"embedding"|"permutating"|"reasoning"|"compositing", progress:10..85, itemCount? }
        setProgress(data);
      });
      s.on("job:complete", (result) => {
        // { designs:[{title, items, mockupUrl, explanation, tips, score, ...}], vertical, itemCount, designCount, generatedAt }
        setJob((prev: any) => ({ ...(prev||{}), status:"completed", result }));
      });
      s.on("job:failed", ({ error }) => {
        setJob((prev: any)=>({...(prev||{}), status:"failed", errorMsg:error}));
      });
      s.on("error", (e) => console.warn("job error", e));
    })();
    return () => {
      s?.emit("unsubscribe:job", jobId);
      s?.off("job:update"); s?.off("job:complete"); s?.off("job:failed");
    };
  }, [jobId]);

  return { job, progress };
}
```

**Events table:**

| Emitted by client | Payload | Server response |
|-------------------|---------|-----------------|
| `subscribe:job` | `jobId: string` (ObjectId) | `subscribed {jobId}` or `error {message}` if invalid/not yours |
| `unsubscribe:job` | `jobId` | `unsubscribed {jobId}` |

| Listened by client | Payload |
|--------------------|---------|
| `job:update` | `{ status:"processing", step, progress:10|25|40|55|70|85, itemCount? }` |
| `job:complete` | `{ designs:[...], vertical, itemCount, designCount, generatedAt }` — save `designs` |
| `job:failed` | `{ error:"Design generation failed. Please try again." }` |

**Steps mapping for UI progress bar:**

| Progress | Step | Label (frontend) |
|----------|------|------------------|
| 10 | `detecting` | Detecting items… |
| 25 | `extracting` | Analyzing colours & textures… |
| 40 | `embedding` | Building style profile… |
| 55 | `permutating` | Exploring combinations… |
| 70 | `reasoning` | AI stylist thinking… |
| 85 | `compositing` | Creating mockups… |
| 100 | `complete` (via `job:complete`) | Done ✨ |

If `detectedItems.length===0`, backend immediately completes with `emptyResult: { designs:[], message:"No items detected..." }` and emits `job:complete` — show retake prompt, no designs.

**Retry semantics:** `runPipeline` throws on catch → `updateJobStatus(..., 'failed')` → `job:failed` → BullMQ retries `3× exponential 3s`. Frontend may see multiple `job:update` bursts if job retries; treat `job:failed` as final after 3 attempts, or implement client retry button that re-uploads.

**Offline/Background:** Push notification is sent on `completed` via Firebase: `"Your Glimms look is ready ✨"` + `data:{jobId, screen:"designs"}`. When app is backgrounded, rely on push to navigate to `JobDetail`.

---

## 10. Saved Designs

These are the **outputs** the AI generated (`reasonedDesigns + mockupCompositor`), which the user can save/toggle favorite.

```http
GET  /api/designs/saved?page=1&limit=20&favorite=true
→ { designs:[SavedDesign], total, page, limit, totalPages }

POST /api/designs/saved
Body: { jobId, title?, items: Record[], mockupUrl?, explanation?, tips?[], score? (0-1) }
→ 201 SavedDesign

PATCH /api/designs/saved/:id/favorite
→ SavedDesign (toggled isFavorite)

DELETE /api/designs/saved/:id
→ { message:"Saved design deleted" }
```

**Model:**

```ts
type SavedDesign = {
  id: string;
  userId: string;
  jobId: string;
  title: string | null;        // user-editable or AI-generated
  items: Record<string,unknown>[]; // catalog item refs + AI attrs
  mockupUrl: string | null;    // S3 or compositor URL
  explanation: string | null;  // LLM reasoning
  tips: string[];
  score: number; // 0-1
  isFavorite: boolean;
  tags: string[];
  createdAt: string;
}
```

**When to call POST:**

After `job:complete` you receive `result.designs` array (from mockup compositor). Show them in a carousel. When user taps “Save” on a card:

```ts
const design = result.designs[0]; // { title, items, mockup_url, explanation, tips, score }
await api.post("/api/designs/saved", {
  jobId,
  title: design.title,
  items: design.items,
  mockupUrl: design.mockup_url ?? design.mockupUrl,
  explanation: design.explanation,
  tips: design.tips,
  score: design.score,
});
```

**Favorites:** Heart button → `PATCH /saved/:id/favorite` (no body). Optimistically toggle `isFavorite`.

**List:** `GET /saved?favorite=true` for Favorites screen.

---

## 11. Catalog

User's wardrobe/room/garden **items** (detected from scans OR manually added).

### Model

```ts
type Vertical = "wardrobe" | "room" | "garden";

type CatalogItem = {
  id: string;
  userId: string;
  vertical: Vertical;
  label: string;        // "white button shirt"
  category: string;     // "top", "bottom", "seating"
  color: {
    dominant: { hex:"#f5f5f5", rgb:{r:245,g:245,b:245} },
    palette: {hex,rgb}[],
    mood: "neutral"|"warm"|"cool"|...
  };
  texture: string | null;
  pattern: string | null;
  imageKey: string;     // S3 key: uploads/<userId>/...jpg
  thumbnailKey: string | null;
  confidence: number; // 0-1
  attributes: Record<string, unknown>; // { bbox, sleeveLength, material }
  tags: string[];      // user-added
  styleTags: string[]; // CLIP from attribute extractor
  isActive: boolean;   // soft-delete flag (GET filters isActive:true)
  createdAt: string; updatedAt: string;

  // when ?includeUrls=true or via /:id/url
  imageUrl?: string;      // presigned GET 900s
  thumbnailUrl?: string;
}
```

### Endpoints

```http
GET  /api/catalog?vertical=wardrobe&category=top&tag=cotton&page=1&limit=20&includeUrls=true
→ { items: CatalogItem[], total, page, limit, totalPages }

GET  /api/catalog/:id
→ CatalogItem

GET  /api/catalog/:id/url
→ { url: "https://glimms-images.s3.amazonaws.com/...?X-Amz-Signature=..." }

POST /api/catalog
Body: { vertical, label, category, color:{dominant:{hex,rgb}, palette?, mood?}, imageKey, thumbnailKey?, confidence:0-1, texture?, pattern?, tags?[], styleTags?[], attributes?{} }
→ 201 CatalogItem

PATCH /api/catalog/:id
Body: { label?, tags?[], styleTags?[], attributes?{} }
→ 200 CatalogItem

DELETE /api/catalog/:id
→ { message:"Item removed from catalog" } (soft: isActive=false)
```

### Implementation guide

**Listing:** Always paginate. Default `limit 20`, `page 1`. For a grid, fetch `limit 20` and implement infinite scroll:

```ts
const { data, fetchNextPage } = useInfiniteQuery({
  queryKey: ["catalog", filters],
  queryFn: ({ pageParam=1 }) => api.get("/api/catalog", { params: { ...filters, page: pageParam, limit: 20, includeUrls: true } }).then(r=>r.data),
  getNextPageParam: (last) => last.page < last.totalPages ? last.page+1 : undefined,
});
```

**Image rendering:** Prefer `includeUrls=true` — one call returns `imageUrl` presigned (900s). Cache the URL but refresh when expired (catch `403` on image load → refetch `/catalog/:id/url`). Alternatively, fetch raw `imageKey` and lazily call `/url` on image press.

**Manual add:** If user wants to add item without scanning (e.g., Pinterest URL), you must first upload image to S3. MVP workaround: require `imageKey` that already exists in S3 (reuse scan upload). Later, add a dedicated `POST /catalog/upload` that does S3 upload for you — for now, document limitation and suggest “Scan to add” as primary path.

**Filters UI:** Chips for `vertical` (`All | Wardrobe | Room | Garden`), search by `category` (autocomplete from existing categories), `tag` multiselect.

**Soft-delete:** `DELETE` sets `isActive:false`; `GET` will hide it. Show “Undo” snackbar — to undo, you’d need an API to `PATCH { isActive:true }` (not exposed, so inform user deletion is permanent for MVP and offer “Restore” local only via re-creating).

---

## 12. Subscriptions (Stripe)

### Endpoints

```http
GET  /api/subscriptions/me
→ { userId, status:"active"|"inactive"|"past_due"|"cancelled", tier:"free", stripeCustomerId, stripeSubscriptionId, currentPeriodEnd, cancelAtPeriodEnd }
   // For new users with no subscription, returns default free (200, not 404)

POST /api/subscriptions/checkout
Body: { priceId: string } // Stripe price ID, e.g., price_1Q...
→ { url: "https://checkout.stripe.com/c/pay/...", id: "cs_..." }

POST /api/subscriptions/webhook
→ Stripe-only, raw body, not called by frontend
```

### Frontend flow (mobile + web)

1. **Show paywall** when `GET /me` → `status:"inactive"` and user hits `SCAN_LIMIT_REACHED` or taps “Upgrade”.
2. Fetch available prices: Ideally backend should expose `GET /subscriptions/prices` (not yet implemented — **gap**). For MVP, hardcode `priceId` in frontend env:

   ```bash
   EXPO_PUBLIC_STRIPE_PREMIUM_PRICE_ID=price_123
   EXPO_PUBLIC_STRIPE_PRO_PRICE_ID=price_456
   ```

3. **Checkout:**
   ```ts
   const { data } = await api.post("/api/subscriptions/checkout", { priceId });
   // data.url is Stripe Checkout URL
   // Mobile: open with *Expo WebBrowser*
   import * as WebBrowser from "expo-web-browser";
   await WebBrowser.openBrowserAsync(data.url);
   // Web: window.location.href = data.url;
   ```

4. **Return URLs:** Backend creates checkout with `success_url: https://app.glimms.ai/dashboard?upgrade=success` and `cancel_url: ...?cancelled=true`. For mobile, configure backend `STRIPE_SUCCESS_URL` to deep link (`glimms://upgrade?success=true`) — currently hardcoded to `https://app.glimms.ai` → you may need to override via env or handle web redirect that deep-links.

5. **Webhook:** Stripe → `POST /webhook` with `Stripe-Signature`. Backend updates `Subscription` and `User.tier`. Frontend polls `GET /me` after returning from checkout (every 2s for 10s) to detect `status:"active"`.

6. **Display tier:** `GET /users/me` returns `tier`. Show badge `FREE | PREMIUM | PRO` and scan quota from `GET /analytics/me` (`scansToday`) + `GET /subscriptions/me` implied limits (`free:10, premium:100`).

**Missing (to request from backend team):**
* `GET /subscriptions/prices` (list Stripe prices)
* `GET /subscriptions/portal` (manage billing portal URL)
* Webhook `STRIPE_WEBHOOK_SECRET` must be set in prod or checkout will silently fail (`received:false`).

---

## 13. Push Notifications

### Register device token

```http
POST /api/notifications/device-token
Body: { token: string, platform: "ios"|"android" }
→ 201 DeviceToken

DELETE /api/notifications/device-token
Body: { token, platform }
→ { message:"Device token removed" }
```

**Expo flow:**

```ts
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";

async function registerPush() {
  if (!Device.isDevice) return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return;

  const token = (await Notifications.getExpoPushTokenAsync()).data; // Expo token — but backend expects FCM?
  // For native FCM, use Firebase: getDevicePushTokenAsync / getFCM...
  // Backend uses firebase-admin `admin.messaging().send({token})` expecting FCM/APNs token, not Expo token.
  // So you must configure Expo with `use-next-notification` or send FCM token:
  const fcmToken = (await Notifications.getDevicePushTokenAsync()).data;

  await api.post("/api/notifications/device-token", { token: fcmToken, platform: Platform.OS as any });
}

useEffect(() => {
  registerPush();
  const sub = Notifications.addNotificationReceivedListener(n => {
    // foreground
  });
  const sub2 = Notifications.addNotificationResponseReceivedListener(response => {
    const { jobId, screen } = response.notification.request.content.data as any;
    if (screen === "designs" && jobId) router.push(`/jobs/${jobId}`);
  });
  return () => { sub.remove(); sub2.remove(); };
}, []);
```

> **Important mismatch:** Backend `firebase-admin` expects **FCM** (Android) / **APNs** (iOS) tokens, not Expo `ExponentPushToken`. If you use Expo managed workflow, either (a) configure `expo-notifications` to get native FCM token (eject or use ` expo-dev-client` + `firebase`), or (b) ask backend to support Expo push via `https://exp.host/--/api/v2/push/send`. For MVP, document this and decide.

**On logout**, call `DELETE /device-token` to avoid ghost pushes.

**Design-ready push:** When pipeline completes, backend sends `"Your Glimms look is ready ✨"` with `data:{jobId, screen:"designs"}`. Handle deep link.

---

## 14. Analytics

```http
POST /api/analytics/track
Body: { event: string, properties?: Record }
→ { tracked:true }  // optionalAuth, anonymous allowed

GET /api/analytics/me
→ { scansToday, catalogCount, savedCount } // requireAuth now
```

**When to track (suggested):**

```ts
await api.post("/api/analytics/track", { event:"scan_uploaded", properties:{ vertical:"wardrobe", imageCount:3 } });
await api.post("/api/analytics/track", { event:"design_saved", properties:{ jobId, score:0.9 } });
await api.post("/api/analytics/track", { event:"catalog_filtered", properties:{ vertical:"room" } });
```

Use for product dashboards; events are buffered in Redis `glimms:analytics:events` (10k cap, not yet drained to ClickHouse — MVP stub).

`GET /me` is useful for home dashboard pills: `”3 scans today · 42 items · 12 saved”`.

---

## 15. Types (Copy-Paste for Frontend)

```ts
// types/api.ts
export type Tier = "free" | "premium" | "pro";
export type Vertical = "wardrobe" | "room" | "garden";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type SubStatus = "active" | "inactive" | "past_due" | "cancelled";

export type User = {
  id: string; email: string; name: string|null; avatarUrl: string|null;
  tier: Tier; isActive: boolean; createdAt: string; updatedAt: string;
};

export type UserPreferences = {
  id: string; userId: string;
  occupation: string|null; styleGoals: string[]; occasions: string[];
  culturalCtx: string|null; location: { lat:number, lon:number, city?:string, country?:string }|null;
  createdAt: string; updatedAt: string;
};

export type CatalogItem = {
  id:string; userId:string; vertical:Vertical; label:string; category:string;
  color:{ dominant:{hex:string,rgb:{r:number,g:number,b:number}}, palette:{hex:string,rgb:any}[], mood:string };
  texture:string|null; pattern:string|null; imageKey:string; thumbnailKey:string|null;
  confidence:number; attributes:Record<string,unknown>; tags:string[]; styleTags:string[];
  isActive:boolean; createdAt:string; updatedAt:string;
  imageUrl?: string | null; thumbnailUrl?: string | null;
};

export type Paginated<T> = { items: T[]; total:number; page:number; limit:number; totalPages:number };
export type PaginatedJobs = { jobs: DesignJob[]; total:number; page:number; limit:number; totalPages:number };
export type PaginatedDesigns = { designs: SavedDesign[]; total:number; page:number; limit:number; totalPages:number };

export type DesignJob = {
  id:string; userId:string; vertical:Vertical; status:JobStatus;
  imageKeys:string[]; contextData: Record<string,unknown> & { climate:any, occasion:string, culturalCtx:string, constraints:any };
  result: null | { designs:any[], vertical:Vertical, itemCount:number, designCount:number, generatedAt:string, message?:string };
  errorMsg: string|null; completedAt:string|null; createdAt:string; updatedAt:string;
};

export type SavedDesign = {
  id:string; userId:string; jobId:string; title:string|null; items:Record<string,unknown>[];
  mockupUrl:string|null; explanation:string|null; tips:string[]; score:number; isFavorite:boolean; tags:string[]; createdAt:string;
};

export type Subscription = {
  userId:string; status:SubStatus; tier?:Tier; stripeCustomerId:string|null;
  stripeSubscriptionId:string|null; currentPeriodEnd:string|null; cancelAtPeriodEnd:boolean;
};

export type JobProgress = {
  status:"processing"; step:"detecting"|"extracting"|"embedding"|"permutating"|"reasoning"|"compositing";
  progress:number; itemCount?:number;
};
export type JobComplete = { designs:any[], vertical:Vertical, itemCount:number, designCount:number, generatedAt:string };

// v1 design-sessions (guide §3.4)
export type SessionStatus = "created"|"uploading"|"queued"|"quality_review"|"detecting"|"extracting"|"permuting"|"embedding"|"reasoning"|"composing"|"completed"|"failed"|"cancelled";
export type StepStatus = "pending"|"running"|"completed"|"failed"|"skipped";
export type DesignSession = {
  session_id:string; status:SessionStatus; vertical:Vertical; progress:number;
  steps: Record<"quality"|"detection"|"attributes"|"context"|"permutations"|"embeddings"|"reasoning"|"mockups", StepStatus>;
  designs: any[]; warnings:string[]; artifacts:{id:string, permutationId:string, objectKey:string, contentType:string, url?:string}[];
  error: { code:string, message:string, details?:unknown, request_id?:string }|null;
  correlationId:string; createdAt:string; updatedAt:string;
};
export type UploadUrl = { image_id:string, object_key:string, upload_url:string, expires_at:string };
```

---

## 16. Screens / Flows to Build

### 16.1 Auth Stack

* **Welcome → Register (email, password, name) → 201 → auto store tokens → Onboarding**
* **Login** (email, password) → handle 401 wrong password, 429 too many attempts (show 15m timer).
* **Splash / Boot:** check `SecureStore.getItem('accessToken')` → `GET /users/me` → if 401 → refresh → if fails → Login.

### 16.2 Onboarding (Preferences)

Questionnaire → `PUT /users/me/preferences`:
* Occupation picker, styleGoals chips (`minimalist`, `professional`, `comfortable`), occasions, culturalCtx, location (ask permission → `lat/lon`).

### 16.3 Home / Dashboard

* Header: tier badge + `scansToday/limit` (`GET /analytics/me` + `X-Scan-*` headers).
* Cards: Recent jobs (`GET /designs/jobs?limit=3`), Catalog preview (`GET /catalog?limit=6&includeUrls=true`), Saved favorites.
* Analytics pills: `catalogCount`, `savedCount`.

### 16.4 Scan Flow (core)

```
[Choose Vertical] → [Camera / Picker 1-5] → [Optional: occasion/occupation/culturalCtx auto-filled from preferences + location]
→ POST /scans/upload (FormData) → 202 {jobId}
→ Navigate to JobProgress (WS subscribe)
→ Progress bar (job:update)
→ On job:complete → show Designs carousel
→ On job:failed or empty designs → show retake prompt
```

* Handle `qualityWarning` banner.
* Handle `429 SCAN_LIMIT_REACHED` → paywall.

### 16.5 Job Detail / Results

* Show `result.designs` each with `mockupUrl` (image), `title`, `explanation`, `tips`, `score`.
* Actions: Save → `POST /designs/saved`, Favorite → `PATCH`, Share.
* Link back to `Catalog` items referenced.

### 16.6 Catalog

* Infinite grid with `vertical/category/tag` filters, search.
* Item detail: large `imageUrl`, color swatches, `styleTags`, edit `tags/styleTags` via `PATCH`, delete via `DELETE`.
* Add manual item: form → `POST /catalog` (need `imageKey` — see Scan flow note).

### 16.7 Saved Designs / Favorites

* Two tabs: All / Favorites (`?favorite=true`).
* Favorite toggle + delete.

### 16.8 Settings

* Profile edit (`PATCH /users/me`), preferences edit (`PUT /preferences`), subscription (`GET /subscriptions/me` → show status, checkout button → WebBrowser, manage portal when available), logout (`POST /auth/logout` + delete tokens + delete device token), deactivate (`DELETE /users/me` → confirm).

---

## 17. State & Caching Recommendations

* **React Query (@tanstack/react-query)**: query keys `["user","me"]`, `["catalog", filters]`, `["jobs", page]`, `["saved", page]`. Invalidate on mutations (save, delete, upload).
* **Zustand / Redux** for auth tokens + user tier.
* **Optimistic updates**: favorite toggle, catalog tag edit.
* **Image caching**: `expo-image` or `react-native-fast-image` for `imageUrl` (presigned URLs rotate — cache with key `imageKey` not URL).
* **WS state**: keep Socket.IO singleton, reconnect on app foreground (`AppState` listener), re-subscribe on reconnect.

```ts
// Example Query
export function useCatalog(filters: {vertical?:Vertical, tag?:string}) {
  return useInfiniteQuery({
    queryKey: ["catalog", filters],
    queryFn: ({ pageParam=1 }) => api.get("/api/catalog", { params:{...filters, page:pageParam, limit:20, includeUrls:true}}).then(r=>r.data),
    getNextPageParam: last => last.page < last.totalPages ? last.page+1 : undefined,
  });
}
```

---

## 18. Web vs Mobile Differences

| Concern | Web (Next.js/Vite) | Mobile (Expo) |
|---------|-------------------|---------------|
| Token store | `localStorage` or `httpOnly` cookie via BFF (your call) | `expo-secure-store` |
| File pick | `<input type=file>` → `File` | `expo-image-picker` → `{uri,name,type}` |
| Location | `navigator.geolocation` | `expo-location` (`requestForegroundPermissionsAsync`) |
| Push | Web Push (not implemented — backend is FCM/APNs only) | FCM/APNs via `expo-notifications` + `firebase` |
| Checkout | `window.location.href = url` (Stripe hosted) | `WebBrowser.openBrowserAsync(url)` → deep link return |
| WS URL | `NEXT_PUBLIC_WS_URL` | `EXPO_PUBLIC_WS_URL` (LAN IP for device) |
| CORS | Must set `Origin` allowlist | No Origin header — auto passes |
| Image display | `<img src={imageUrl} />` | `<Image source={{uri: imageUrl}} />` |

---

## 19. Security Checklist (Frontend Must Do)

- [ ] **Never log tokens** — ensure `console.log` doesn’t dump `Authorization` headers (pino redacts on backend, you should too).
- [ ] **Refresh before expiry** — schedule refresh at `expiresIn - 60s` or on 401. Don’t store refresh token in URL or plain `AsyncStorage`.
- [ ] **Handle token rotation atomically** — queue failed requests while refreshing (see interceptor).
- [ ] **Validate `priceId` client-side** — only allow allowlisted `price_*` from your env, never accept from user input.
- [ ] **Sanitize rich text** — `explanation`/`tips` from LLM may contain HTML; render as plain text or sanitize before `dangerouslySetInnerHTML`.
- [ ] **Deep link validation** — when opening `data.url` for Stripe, verify it starts with `https://checkout.stripe.com/` before `openBrowserAsync`.
- [ ] **WS auth** — fetch fresh `accessToken` before `io(auth:{token})`; on `connect_error` “Invalid or expired token” → refresh then reconnect.
- [ ] **S3 URL expiry** — presigned URLs expire `900s`; on image `onError` 403, refetch `/catalog/:id/url`.

---

## 20. Example: Full Scan Flow (Expo + React)

```tsx
// screens/ScanScreen.tsx
import { useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { api } from "@/lib/api";
import { useRouter } from "expo-router";

export default function ScanScreen() {
  const router = useRouter();
  const [vertical, setVertical] = useState<Vertical>("wardrobe");
  const [uploading, setUploading] = useState(false);

  async function pickAndUpload() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== "granted") return alert("Need gallery access");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 5,
      quality: 0.9,
    });
    if (result.canceled) return;

    setUploading(true);
    try {
      // Optional: location for climate context
      let loc: any = {};
      const locPerm = await Location.requestForegroundPermissionsAsync();
      if (locPerm.status === "granted") {
        const pos = await Location.getCurrentPositionAsync({});
        loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      }

      const form = new FormData();
      result.assets.forEach((a, i) => {
        form.append("images", { uri: a.uri, name: `scan_${i}.jpg`, type: "image/jpeg" } as any);
      });
      form.append("vertical", vertical);
      form.append("occasion", "casual");
      if (loc.lat) { form.append("lat", String(loc.lat)); form.append("lon", String(loc.lon)); }

      const { data } = await api.post("/api/scans/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // data: { jobId, estimatedSeconds, qualityWarning? }
      if (data.qualityWarning) alert(data.qualityWarning);
      router.push({ pathname: "/jobs/[id]", params: { id: data.jobId } });
    } catch (e: any) {
      const d = e.response?.data;
      if (d?.code === "SCAN_LIMIT_REACHED") {
        alert(`Daily limit ${d.scansUsed}/${d.limit}. Upgrade?`);
        router.push("/paywall");
      } else if (d?.code === "VALIDATION_ERROR") {
        alert(d.details.map((x:any)=>x.message).join("\n"));
      } else {
        alert(d?.error ?? "Upload failed");
      }
    } finally { setUploading(false); }
  }

  return (
    <View>
      <Picker selectedValue={vertical} onValueChange={setVertical}>
        <Picker.Item label="Wardrobe" value="wardrobe" />
        <Picker.Item label="Room" value="room" />
        <Picker.Item label="Garden" value="garden" />
      </Picker>
      <Button title={uploading ? "Uploading…" : "Pick images"} onPress={pickAndUpload} disabled={uploading} />
    </View>
  );
}

// screens/JobScreen.tsx
import { useLocalSearchParams } from "expo-router";
import { useDesignJob } from "@/lib/socket";

export default function JobScreen() {
  const { id } = useLocalSearchParams<{id:string}>();
  const { job, progress } = useDesignJob(id!);

  if (job?.status === "failed") return <Text>{job.errorMsg}</Text>;
  if (job?.result) return <DesignCarousel designs={job.result.designs} jobId={id!} />;

  return (
    <View>
      <Text>{progress.step} — {progress.progress}%</Text>
      <ProgressBar progress={progress.progress/100} />
      <Text>{progress.itemCount ? `${progress.itemCount} items detected` : ""}</Text>
    </View>
  );
}
```

**Design carousel save:**

```ts
async function onSave(design: any, jobId: string) {
  await api.post("/api/designs/saved", {
    jobId,
    title: design.title,
    items: design.items,
    mockupUrl: design.mockupUrl ?? design.mockup_url,
    explanation: design.explanation,
    tips: design.tips,
    score: design.score,
  });
}
```

---

## 21. What Not to Build (Backend-Only)

Frontend should **not** re-implement:

* JWT signing / `bcrypt` — handled by `auth.service`.
* S3 upload logic beyond `FormData` — backend does `sharp` + `uploadToS3` + `qualityGuard`.
* BullMQ queue, AI pipeline steps (object detection 8001, attribute 8002, etc) — just poll/WS.
* Stripe signature verification (`/webhook` needs `express.raw` + `Stripe-Signature` header) — Stripe → backend directly.
* Rate limiter counters — just display `X-Scan-*` headers; don’t calculate client-side.
* TTL cleanup for refresh tokens — MongoDB does.

---

## 22. Appendix: All Endpoints Reference (Copy-Paste)

**Base:** `http://localhost:4000` → prefix `/api`

```http
# Auth
POST   /api/auth/register            { email, password, name? } → 201 { accessToken, refreshToken, expiresIn }
POST   /api/auth/login               { email, password } → 200 { ... }
POST   /api/auth/refresh             { refreshToken } → 200 { ... }  # rotates
POST   /api/auth/logout              { refreshToken } → 200 { message }

# Users
GET    /api/users/me                 @requireAuth → User
PATCH  /api/users/me                 @requireAuth { name?, avatarUrl? }
DELETE /api/users/me                 @requireAuth → { message }
GET    /api/users/me/preferences     @requireAuth → Preferences|{}
PUT    /api/users/me/preferences     @requireAuth { occupation?, styleGoals?[], occasions?[], culturalCtx?, location?{lat,lon,city?,country?} }

# v1 Design Sessions (recommended — per implementation guide §3, replaces Scans for new clients)
POST   /v1/design-sessions           @requireAuth + scanLimiter { vertical, occasion?, culture?, climate?{temperature_c,humidity}, preferences?{styles,excluded_labels,coverage}, imageCount?1-5 } → 201 { session_id, status, upload_urls:[{image_id,object_key,upload_url,expires_at}], correlationId }
POST   /v1/design-sessions/:id/images/complete @requireAuth { image_ids:[...] } → 200 { session_id, status:"queued", image_count, message }
GET    /v1/design-sessions/:id       @requireAuth → { session_id, status, vertical, progress, steps:{quality,detection,attributes,context,permutations,embeddings,reasoning,mockups}, designs, warnings, artifacts, error, correlationId }
GET    /v1/design-sessions           @requireAuth ?page&limit → { sessions, total, page, limit, totalPages }
DELETE /v1/design-sessions/:id       @requireAuth → { session_id, status:"cancelled" }
# Scans (entry point — legacy deprecated, proxies via API; prefer v1 above)
POST   /api/scans/upload             @requireAuth + scanLimiter  multipart(images[1..5], vertical, occasion?, occupation?, culturalCtx?, lat?, lon?) → 202 { jobId, status, estimatedSeconds, qualityWarning? } (deprecated)

# Catalog
GET    /api/catalog                  @requireAuth ?vertical&category&tag&page&limit&includeUrls → { items, total, page, limit, totalPages }
GET    /api/catalog/:id              @requireAuth → CatalogItem
GET    /api/catalog/:id/url          @requireAuth → { url }
POST   /api/catalog                  @requireAuth { vertical, label, category, color, imageKey, confidence, ... } → 201 CatalogItem
PATCH  /api/catalog/:id              @requireAuth { label?, tags?, styleTags?, attributes? }
DELETE /api/catalog/:id              @requireAuth → { message } # soft

# Designs
GET    /api/designs/jobs             @requireAuth ?page&limit → { jobs, total, page, limit, totalPages }
GET    /api/designs/jobs/:id         @requireAuth → DesignJob
GET    /api/designs/saved            @requireAuth ?page&limit&favorite → { designs, total, page, limit, totalPages }
POST   /api/designs/saved            @requireAuth { jobId, title?, items[], mockupUrl?, explanation?, tips?[], score? }
PATCH  /api/designs/saved/:id/favorite @requireAuth → SavedDesign
DELETE /api/designs/saved/:id        @requireAuth → { message }

# Subscriptions
GET    /api/subscriptions/me         @requireAuth → Subscription (default free if none)
POST   /api/subscriptions/checkout   @requireAuth { priceId } → { url, id }
POST   /api/subscriptions/webhook    Stripe raw body + Stripe-Signature → { received:true }

# Notifications
POST   /api/notifications/device-token  @requireAuth { token, platform:"ios"|"android" } → 201
DELETE /api/notifications/device-token  @requireAuth { token, platform } → { message }

# Analytics
POST   /api/analytics/track          @optionalAuth { event, properties? } → { tracked:true }
GET    /api/analytics/me             @requireAuth → { scansToday, catalogCount, savedCount }

# Health
GET    /health                       → { status:"ok"|"degraded", checks:{mongodb,redis}, uptime, ts }

# WebSocket (Socket.IO) — subscribe to legacy jobs *or* v1 sessions (guide §3.4 recommends WS or polling)
WS     /  (Socket.IO) auth: { token } or header Bearer
  → emit subscribe:job(jobId) → on subscribed, job:update, job:complete, job:failed, error  (legacy)
  → emit unsubscribe:job(jobId)
  → emit subscribe:session(sessionId) | subscribe:design-session(sessionId) → on subscribed, session:update, job:update, job:complete, job:failed (v1 preferred)
  → emit unsubscribe:session(sessionId)
```

**Auth header:** `Authorization: Bearer <accessToken>`  
**Content types:** `application/json` except `POST /scans/upload` is `multipart/form-data` and `POST /subscriptions/webhook` is `application/json` raw.  
**Success codes:** `200`, `201` (created), `202` (accepted — scan).

---

## Quick Start Checklist for Frontend Dev

- [ ] Set `API_URL` / `WS_URL` env + add to backend `ALLOWED_ORIGINS`.
- [ ] Implement axios + refresh interceptor (queue 401s).
- [ ] Secure storage for tokens (`SecureStore` / `httpOnly`).
- [ ] Build Splash → `GET /users/me` with refresh fallback.
- [ ] Onboarding → `PUT /preferences` with location permission.
- [ ] **v1 Sessions (preferred):** `POST /v1/design-sessions {vertical,occasion,culture,climate,preferences,imageCount}` → `PUT` each `upload_url` directly to S3 (no auth header) → `POST /v1/design-sessions/:id/images/complete {image_ids}` → handle `400` validation & `429 SCAN_LIMIT_REACHED`.
- [ ] Legacy fallback (deprecated): Scan picker → `FormData` `POST /api/scans/upload` → handle `202`/`429`/`qualityWarning` (will be removed — migrate to v1).
- [ ] Job progress → Socket.IO `subscribe:job` + `job:*` listeners + fallback poll, push notification deep link.
- [ ] Catalog list with infinite scroll `includeUrls=true`, detail + edit/delete.
- [ ] Saved designs list + favorite + delete.
- [ ] Paywall → `GET /subscriptions/me` → `POST /checkout` → `WebBrowser` + poll `GET /me`.
- [ ] Push registration on login (`POST /device-token`) + remove on logout.
- [ ] Analytics `track` calls + `GET /me` dashboard.
- [ ] Error toasts per `code` table + scan-limit headers UI.
- [ ] Image error fallback (403 → refetch presigned).

---

*Questions? Check `AUDIT_REPORT.md` for backend decisions, or open an issue against `glimms-api`.*

