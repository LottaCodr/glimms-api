/**
 * Auth service unit tests.
 * Uses in-memory MongoDB via mongoose.connect() against a real local instance.
 */
import mongoose from 'mongoose';
import { authService } from '../services/auth.service';
import { User } from '../models/User';
import { RefreshToken } from '../models/RefreshToken';

// Each test file gets its own database so parallel jest workers never collide.
const MONGO_URI = `${process.env.MONGODB_URI ?? 'mongodb://localhost:27017/glimms_test'}_auth`;

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await User.deleteMany({});
  await RefreshToken.deleteMany({});
});

describe('authService.register', () => {
  it('creates a user and returns token pair', async () => {
    const result = await authService.register({
      email:    'lottanna@glimms.ai',
      password: 'securepassword123',
      name:     'Lotanna',
    });

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.expiresIn).toBe(900);
  });

  it('stores the user with a hashed password', async () => {
    await authService.register({ email: 'test@glimms.ai', password: 'password123' });
    const user = await User.findOne({ email: 'test@glimms.ai' }).select('+passwordHash');
    expect(user).not.toBeNull();
    expect(user!.passwordHash).not.toBe('password123');
    expect(user!.tier).toBe('free');
  });

  it('throws ConflictError on duplicate email', async () => {
    await authService.register({ email: 'dup@glimms.ai', password: 'password123' });
    await expect(
      authService.register({ email: 'dup@glimms.ai', password: 'otherpassword' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('stores email in lowercase', async () => {
    await authService.register({ email: 'UPPER@GLIMMS.AI', password: 'password123' });
    const user = await User.findOne({ email: 'upper@glimms.ai' });
    expect(user).not.toBeNull();
  });
});

describe('authService.login', () => {
  beforeEach(async () => {
    await authService.register({ email: 'login@glimms.ai', password: 'mypassword' });
  });

  it('returns tokens for valid credentials', async () => {
    const result = await authService.login({ email: 'login@glimms.ai', password: 'mypassword' });
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it('throws UnauthorizedError for wrong password', async () => {
    await expect(
      authService.login({ email: 'login@glimms.ai', password: 'wrongpassword' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws UnauthorizedError for unknown email', async () => {
    await expect(
      authService.login({ email: 'ghost@glimms.ai', password: 'password' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.refresh', () => {
  it('rotates the refresh token', async () => {
    const { refreshToken: rt1 } = await authService.register({
      email: 'refresh@glimms.ai', password: 'password123',
    });

    const { refreshToken: rt2 } = await authService.refresh(rt1);

    // Old token should be invalidated
    await expect(authService.refresh(rt1)).rejects.toMatchObject({ statusCode: 401 });

    // New token should work
    const { accessToken } = await authService.refresh(rt2);
    expect(accessToken).toBeDefined();
  });

  it('throws for invalid token', async () => {
    await expect(authService.refresh('not-a-real-token')).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.logout', () => {
  it('invalidates the refresh token', async () => {
    const { refreshToken } = await authService.register({
      email: 'logout@glimms.ai', password: 'password123',
    });

    await authService.logout(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });
});
