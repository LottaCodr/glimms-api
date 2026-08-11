import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

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

  AI_OBJECT_DETECTION_URL:     z.string().default('http://localhost:8001'),
  AI_ATTRIBUTE_EXTRACTOR_URL:  z.string().default('http://localhost:8002'),
  AI_EMBEDDING_ENGINE_URL:     z.string().default('http://localhost:8003'),
  AI_PERMUTATION_ENGINE_URL:   z.string().default('http://localhost:8004'),
  AI_LLM_REASONING_URL:        z.string().default('http://localhost:8005'),
  AI_MOCKUP_COMPOSITOR_URL:    z.string().default('http://localhost:8006'),
  AI_QUALITY_GUARD_URL:        z.string().default('http://localhost:8007'),
  AI_CONTEXT_INFERENCE_URL:    z.string().default('http://localhost:8008'),

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
    objectDetection:    e.AI_OBJECT_DETECTION_URL,
    attributeExtractor: e.AI_ATTRIBUTE_EXTRACTOR_URL,
    embeddingEngine:    e.AI_EMBEDDING_ENGINE_URL,
    permutationEngine:  e.AI_PERMUTATION_ENGINE_URL,
    llmReasoning:       e.AI_LLM_REASONING_URL,
    mockupCompositor:   e.AI_MOCKUP_COMPOSITOR_URL,
    qualityGuard:       e.AI_QUALITY_GUARD_URL,
    contextInference:   e.AI_CONTEXT_INFERENCE_URL,
  },

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
