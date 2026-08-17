import dotenv from 'dotenv';
import { z } from 'zod';
import { resolveAiUrls, resolveAiUrlsDetailed, normalizeBaseUrl } from './aiUrls';

dotenv.config();

/** Treat `FOO=` (blank) in a .env file as "not set" rather than an invalid value. */
const blankAsUndefined = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = z.object({
  PORT:                     z.string().default('4000'),
  NODE_ENV:                 z.enum(['development', 'staging', 'production', 'test']).default('development'),

  MONGODB_URI:              z.string().default('mongodb://localhost:27017/glimms'),
  REDIS_URL:                z.string().default('redis://localhost:6379'),

  JWT_SECRET:               z.string().min(32),
  JWT_EXPIRES_IN:           z.string().default('15m'),
  REFRESH_TOKEN_SECRET:     z.string().min(32),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS:            z.string().default('12'),

  AWS_REGION:               z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID:        z.string().optional(),
  AWS_SECRET_ACCESS_KEY:    z.string().optional(),
  S3_BUCKET:                z.string().default('glimms-images'),
  S3_PRESIGN_EXPIRY_SECONDS: z.string().default('900'),

  // AI services — either one gateway (AI_GATEWAY_URL, path-prefixed) or a URL
  // per service. Per-service values win; see ./aiUrls.ts for resolution rules.
  AI_GATEWAY_URL:              blankAsUndefined(z.string().url().optional()),
  AI_OBJECT_DETECTION_URL:     z.string().optional(),
  AI_ATTRIBUTE_EXTRACTOR_URL:  z.string().optional(),
  AI_EMBEDDING_ENGINE_URL:     z.string().optional(),
  AI_PERMUTATION_ENGINE_URL:   z.string().optional(),
  AI_LLM_REASONING_URL:        z.string().optional(),
  AI_MOCKUP_COMPOSITOR_URL:    z.string().optional(),
  AI_QUALITY_GUARD_URL:        z.string().optional(),
  AI_CONTEXT_INFERENCE_URL:    z.string().optional(),
  // Scales every AI request timeout. Hosted free tiers (Render) cold-start in
  // ~30-60s after idling, which blows the default per-call timeouts.
  AI_TIMEOUT_MULTIPLIER:       blankAsUndefined(z.string().default('1')),
  // Treat 'degraded' AI services (model_loaded:false / in-memory vector store,
  // i.e. the lightweight fallback build) as ready in GET /health/ready.
  AI_ALLOW_DEGRADED:           blankAsUndefined(z.enum(['true','false']).default('false')),

  STRIPE_SECRET_KEY:           z.string().optional(),
  STRIPE_WEBHOOK_SECRET:       z.string().optional(),
  STRIPE_FREE_SCAN_LIMIT:      z.string().default('10'),
  STRIPE_PREMIUM_SCAN_LIMIT:   z.string().default('100'),

  FIREBASE_PROJECT_ID:    z.string().optional(),
  FIREBASE_CLIENT_EMAIL:  z.string().optional(),
  FIREBASE_PRIVATE_KEY:   z.string().optional(),

  SENDGRID_API_KEY:       z.string().optional(),
  SENDGRID_FROM_EMAIL:    z.string().default('hello@glimms.ai'),

  PINECONE_API_KEY:       z.string().optional(),
  PINECONE_INDEX:         z.string().default('glimms-style'),

  ALLOWED_ORIGINS:          z.string().default('http://localhost:3000'),
  RATE_LIMIT_WINDOW_MS:     z.string().default('900000'),
  RATE_LIMIT_MAX_REQUESTS:  z.string().default('100'),

  OPENWEATHER_API_KEY:    z.string().optional(),

  // Internal service-to-service auth (added per backend implementation guide §4)
  AI_INTERNAL_TOKEN:       z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('\n❌  Invalid environment variables:\n');
  Object.entries(parsed.error.flatten().fieldErrors).forEach(([k, v]) => {
    console.error(`  ${k}: ${v?.join(', ')}`);
  });
  process.exit(1);
}

const e = parsed.data;

const aiUrls         = resolveAiUrls(process.env);
const aiUrlsDetailed = resolveAiUrlsDetailed(process.env);

const timeoutMultiplier = (() => {
  const n = parseFloat(e.AI_TIMEOUT_MULTIPLIER);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

export const config = {
  port:    parseInt(e.PORT),
  nodeEnv: e.NODE_ENV,
  isDev:   e.NODE_ENV === 'development',

  mongodb: { uri: e.MONGODB_URI },
  redis:   { url: e.REDIS_URL },

  jwt: {
    secret:           e.JWT_SECRET,
    expiresIn:        e.JWT_EXPIRES_IN,
    refreshSecret:    e.REFRESH_TOKEN_SECRET,
    refreshExpiresIn: e.REFRESH_TOKEN_EXPIRES_IN,
  },

  bcryptRounds: parseInt(e.BCRYPT_ROUNDS),

  aws: {
    region:       e.AWS_REGION,
    s3Bucket:     e.S3_BUCKET,
    presignExpiry: parseInt(e.S3_PRESIGN_EXPIRY_SECONDS),
  },

  ai: {
    objectDetection:    aiUrls.objectDetection,
    attributeExtractor: aiUrls.attributeExtractor,
    embeddingEngine:    aiUrls.embeddingEngine,
    permutationEngine:  aiUrls.permutationEngine,
    llmReasoning:       aiUrls.llmReasoning,
    mockupCompositor:   aiUrls.mockupCompositor,
    qualityGuard:       aiUrls.qualityGuard,
    contextInference:   aiUrls.contextInference,
  },

  /** Set when all services are reached through one path-prefixed origin. */
  aiGatewayUrl: e.AI_GATEWAY_URL ? normalizeBaseUrl(e.AI_GATEWAY_URL) : undefined,
  /** How each URL above was resolved — surfaced by GET /health/ready. */
  aiUrlSources: aiUrlsDetailed,
  /** Multiplier applied to every AI HTTP timeout (cold-start headroom). */
  aiTimeoutMultiplier: timeoutMultiplier,
  /** Whether GET /health/ready passes when services run offline/fallback backends. */
  aiAllowDegraded: e.AI_ALLOW_DEGRADED === 'true',

  stripe: {
    secretKey:        e.STRIPE_SECRET_KEY,
    webhookSecret:    e.STRIPE_WEBHOOK_SECRET,
    freeScanLimit:    parseInt(e.STRIPE_FREE_SCAN_LIMIT),
    premiumScanLimit: parseInt(e.STRIPE_PREMIUM_SCAN_LIMIT),
  },

  firebase: {
    projectId:   e.FIREBASE_PROJECT_ID,
    clientEmail: e.FIREBASE_CLIENT_EMAIL,
    privateKey:  e.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },

  sendgrid: {
    apiKey:    e.SENDGRID_API_KEY,
    fromEmail: e.SENDGRID_FROM_EMAIL,
  },

  pinecone: {
    apiKey: e.PINECONE_API_KEY,
    index:  e.PINECONE_INDEX,
  },

  cors:      { allowedOrigins: e.ALLOWED_ORIGINS.split(',').map(o => o.trim()) },
  rateLimit: { windowMs: parseInt(e.RATE_LIMIT_WINDOW_MS), max: parseInt(e.RATE_LIMIT_MAX_REQUESTS) },
  openweather: { apiKey: e.OPENWEATHER_API_KEY },
  aiInternalToken: e.AI_INTERNAL_TOKEN,
} as const;
