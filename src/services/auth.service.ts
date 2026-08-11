import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User, RefreshToken } from '../models';
import { config } from '../config';
import { ConflictError, UnauthorizedError } from '../middleware/errorHandler.middleware';

export interface RegisterInput { email: string; password: string; name?: string }
export interface LoginInput    { email: string; password: string }

// ── Token pair generator ──────────────────────────────────────────────────────

async function issueTokenPair(userId: string, email: string, tier: string) {
  // Access token (short-lived)
  const accessToken = jwt.sign(
    { sub: userId, email, tier },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );

  // Refresh token (long-lived, stored as hash in MongoDB)
  const rawRefresh  = crypto.randomBytes(48).toString('hex');
  const tokenHash   = crypto.createHash('sha256').update(rawRefresh).digest('hex');
  const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await RefreshToken.create({ userId, tokenHash, expiresAt });

  return { accessToken, refreshToken: rawRefresh, expiresIn: 900 };
}

// ── Public service methods ────────────────────────────────────────────────────

export const authService = {

  async register({ email, password, name }: RegisterInput) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const user = await User.create({ email: email.toLowerCase(), passwordHash, name });

    return issueTokenPair(user._id.toString(), user.email, user.tier);
  },

  async login({ email, password }: LoginInput) {
    // Must select passwordHash — it's excluded by default via `select: false`
    const user = await User
      .findOne({ email: email.toLowerCase(), isActive: true })
      .select('+passwordHash');

    if (!user) throw new UnauthorizedError('Invalid credentials');
    if (!user.passwordHash) throw new UnauthorizedError('Please use social sign-in for this account');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    return issueTokenPair(user._id.toString(), user.email, user.tier);
  },

  async refresh(rawRefreshToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    const stored = await RefreshToken
      .findOne({ tokenHash, expiresAt: { $gt: new Date() } })
      .populate<{ userId: { _id: any; email: string; tier: string; isActive: boolean } }>({
        path:   'userId',
        select: 'email tier isActive',
      });

    if (!stored) throw new UnauthorizedError('Refresh token is invalid or expired');

    const u = stored.userId as any;
    if (!u?.isActive) throw new UnauthorizedError('Account is deactivated');

    // Rotate: delete the used token, issue a new pair
    await RefreshToken.deleteOne({ _id: stored._id });
    return issueTokenPair(u._id.toString(), u.email, u.tier);
  },

  async logout(rawRefreshToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    await RefreshToken.deleteMany({ tokenHash });
    return { message: 'Logged out successfully' };
  },
};
