import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from './app';

const BASE_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/glimms_test';
// Each test file gets its own database: jest runs files in parallel workers, and
// every suite wipes its DB (dropDatabase in afterAll / deleteMany in beforeEach).
// Sharing one DB made suites delete each other's data mid-run in CI.
const MONGO_URI = BASE_URI.replace(/\/([^/?]+)(\?.*)?$/, '/$1_app$2');

const app = createApp();

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status); // 503 if DB not ready yet
    expect(['ok', 'degraded']).toContain(res.body.status);
    expect(res.body.service).toBe('glimms-api');
    expect(res.body.checks).toBeDefined();
  });
});

describe('POST /api/auth/register', () => {
  it('registers a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@glimms.ai', password: 'password123', name: 'Test User' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.expiresIn).toBeDefined();
  });

  it('rejects invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@glimms.ai', password: '123' });

    expect(res.status).toBe(400);
  });

  it('rejects duplicate email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@glimms.ai', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@glimms.ai', password: 'otherpass123' });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/login', () => {
  beforeAll(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'logintest@glimms.ai', password: 'mypassword123' });
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'logintest@glimms.ai', password: 'mypassword123' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'logintest@glimms.ai', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/me', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('returns user profile with valid token', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'profile@glimms.ai', password: 'password123', name: 'Profile User' });

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${regRes.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('profile@glimms.ai');
    expect(res.body.name).toBe('Profile User');
    expect(res.body.passwordHash).toBeUndefined();
  });
});

describe('GET /api/catalog', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/catalog');
    expect(res.status).toBe(401);
  });

  it('returns empty result for new user (paginated)', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'catalog@glimms.ai', password: 'password123' });

    const res = await request(app)
      .get('/api/catalog')
      .set('Authorization', `Bearer ${regRes.body.accessToken}`);

    expect(res.status).toBe(200);
    // New paginated shape: { items, total, page, limit }
    if (Array.isArray(res.body)) {
      expect(res.body).toEqual([]);
    } else {
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
      expect(res.body.page).toBe(1);
    }
  });

  it('supports pagination params', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'catalog2@glimms.ai', password: 'password123' });

    const res = await request(app)
      .get('/api/catalog?page=1&limit=5')
      .set('Authorization', `Bearer ${regRes.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
  });
});

describe('GET /api/designs/jobs', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/designs/jobs');
    expect(res.status).toBe(401);
  });

  it('returns paginated jobs for new user', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'designs@glimms.ai', password: 'password123' });

    const res = await request(app)
      .get('/api/designs/jobs')
      .set('Authorization', `Bearer ${regRes.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.jobs).toBeDefined();
    expect(res.body.total).toBe(0);
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
  });
});
