/**
 * AI service URL resolution.
 *
 * Two supported deployment topologies:
 *
 * 1. **Split hosts** (docker-compose / k8s private DNS) — one host per service:
 *      AI_OBJECT_DETECTION_URL=http://object-detection:8001
 *
 * 2. **Single gateway** (e.g. the Render deployment at https://glimms-ai.onrender.com) —
 *    all eight services behind one origin, addressed by path prefix:
 *      AI_GATEWAY_URL=https://glimms-ai.onrender.com
 *    which resolves object-detection to https://glimms-ai.onrender.com/object-detection
 *
 * Precedence: an explicit per-service AI_*_URL always wins, then AI_GATEWAY_URL,
 * then the localhost dev default. That means a gateway can be used for most
 * services while a single one is pinned elsewhere.
 */

export const AI_SERVICE_KEYS = [
  'objectDetection',
  'attributeExtractor',
  'embeddingEngine',
  'permutationEngine',
  'llmReasoning',
  'mockupCompositor',
  'qualityGuard',
  'contextInference',
] as const;

export type AiServiceKey = (typeof AI_SERVICE_KEYS)[number];

/** Path prefix used by the gateway, and the service name reported by /health. */
export const AI_SERVICE_SLUGS: Record<AiServiceKey, string> = {
  objectDetection:    'object-detection',
  attributeExtractor: 'attribute-extractor',
  embeddingEngine:    'embedding-engine',
  permutationEngine:  'permutation-engine',
  llmReasoning:       'llm-reasoning',
  mockupCompositor:   'mockup-compositor',
  qualityGuard:       'quality-guard',
  contextInference:   'context-inference',
};

/** Port each service listens on when run as its own container. */
export const AI_SERVICE_PORTS: Record<AiServiceKey, number> = {
  objectDetection:    8001,
  attributeExtractor: 8002,
  embeddingEngine:    8003,
  permutationEngine:  8004,
  llmReasoning:       8005,
  mockupCompositor:   8006,
  qualityGuard:       8007,
  contextInference:   8008,
};

/** Per-service override env var names. */
export const AI_SERVICE_ENV_KEYS: Record<AiServiceKey, string> = {
  objectDetection:    'AI_OBJECT_DETECTION_URL',
  attributeExtractor: 'AI_ATTRIBUTE_EXTRACTOR_URL',
  embeddingEngine:    'AI_EMBEDDING_ENGINE_URL',
  permutationEngine:  'AI_PERMUTATION_ENGINE_URL',
  llmReasoning:       'AI_LLM_REASONING_URL',
  mockupCompositor:   'AI_MOCKUP_COMPOSITOR_URL',
  qualityGuard:       'AI_QUALITY_GUARD_URL',
  contextInference:   'AI_CONTEXT_INFERENCE_URL',
};

export type AiUrlSource = 'service-env' | 'gateway' | 'default';

export interface ResolvedAiUrl {
  url:    string;
  source: AiUrlSource;
}

/**
 * Strip trailing slashes so callers can safely do `${baseUrl}/detect`.
 * `https://host/object-detection/` -> `https://host/object-detection`
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function resolveAiUrlsDetailed(
  env: NodeJS.ProcessEnv = process.env,
): Record<AiServiceKey, ResolvedAiUrl> {
  const rawGateway = env.AI_GATEWAY_URL?.trim();
  const gateway    = rawGateway ? normalizeBaseUrl(rawGateway) : '';

  const out = {} as Record<AiServiceKey, ResolvedAiUrl>;
  for (const key of AI_SERVICE_KEYS) {
    const explicit = env[AI_SERVICE_ENV_KEYS[key]]?.trim();
    if (explicit) {
      out[key] = { url: normalizeBaseUrl(explicit), source: 'service-env' };
    } else if (gateway) {
      out[key] = { url: `${gateway}/${AI_SERVICE_SLUGS[key]}`, source: 'gateway' };
    } else {
      out[key] = { url: `http://localhost:${AI_SERVICE_PORTS[key]}`, source: 'default' };
    }
  }
  return out;
}

/** Flat `{ objectDetection: 'https://…/object-detection', … }` map for `config.ai`. */
export function resolveAiUrls(
  env: NodeJS.ProcessEnv = process.env,
): Record<AiServiceKey, string> {
  const detailed = resolveAiUrlsDetailed(env);
  const out = {} as Record<AiServiceKey, string>;
  for (const key of AI_SERVICE_KEYS) out[key] = detailed[key].url;
  return out;
}

/** `{ 'object-detection': 'https://…/object-detection', … }` — slug-keyed, for health reporting. */
export function aiUrlsBySlug(urls: Record<AiServiceKey, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of AI_SERVICE_KEYS) out[AI_SERVICE_SLUGS[key]] = urls[key];
  return out;
}
