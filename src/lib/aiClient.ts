import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { AI_SERVICE_SLUGS, aiUrlsBySlug } from '../config/aiUrls';
import {
  AiFallbackBlockedError,
  Semaphore,
  asFallbackBlocked,
  backoffDelayMs,
  breakerFor,
  isRetryableStatus,
} from './aiTransport';
import { logger } from './logger';

/**
 * Centralized AI service HTTP client.
 *
 * Every call to the Glimms AI tier goes through here so that authentication,
 * timeouts, retries, correlation IDs, the concurrency cap and the circuit
 * breaker are applied uniformly — including health checks, which the gateway
 * also protects with the bearer token.
 *
 * See README "Connecting to the AI services".
 */

export interface AiCallOpts {
  correlationId: string;
  requestId?: string;
  timeout?: number;
  retries?: number;
}

/** Shared across the process: the gateway runs all eight services in one container. */
const semaphore = new Semaphore(config.aiMaxConcurrency);

function headers(correlationId: string, requestId?: string) {
  const h: Record<string,string> = {
    'Content-Type': 'application/json',
    'X-Correlation-ID': correlationId,
    'X-Request-ID': requestId || correlationId,
  };
  if (config.aiInternalToken) {
    h['Authorization'] = `Bearer ${config.aiInternalToken}`;
  }
  return h;
}

/** Auth-only headers, for GET health probes. */
function authHeaders(): Record<string,string> {
  return config.aiInternalToken
    ? { Authorization: `Bearer ${config.aiInternalToken}` }
    : {};
}

/**
 * Scale a timeout by AI_TIMEOUT_MULTIPLIER and cap it at GLIMMS_TIMEOUT_MS.
 * Render's free tier sleeps when idle: the first call after a spin-down can
 * take 30-60s just to get a connection.
 */
function t(ms: number): number {
  return Math.min(Math.round(ms * config.aiTimeoutMultiplier), config.aiMaxTimeoutMs);
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; correlationId: string; step: string; service?: string },
): Promise<T> {
  const service = opts.service ?? opts.step;
  const breaker = breakerFor(service, config.aiBreakerThreshold, config.aiBreakerResetMs);
  let lastErr: any;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    // Fails fast (and throws a retryable error) while the circuit is open.
    breaker.assertClosed(service);
    try {
      const result = await semaphore.run(fn);
      breaker.onSuccess();
      return result;
    } catch (err: any) {
      lastErr = err;
      const status = err.response?.status;

      // A production-mode gateway refusing to serve prototype output is a
      // configuration problem: surface it immediately, never retry.
      const blocked = asFallbackBlocked(err);
      if (blocked) {
        breaker.onSuccess(); // the service is healthy — it is answering correctly
        logger.error(
          { step: opts.step, service: blocked.service, reason: blocked.reason, remedy: blocked.remedy, correlationId: opts.correlationId },
          'AI service refused to return development-fallback output',
        );
        throw blocked;
      }

      // Never retry validation/auth/not-found.
      if (status && !isRetryableStatus(status)) {
        breaker.onSuccess(); // the service responded; it is our request that is wrong
        logger.warn({ step: opts.step, status, correlationId: opts.correlationId }, 'AI service non-retryable error');
        throw err;
      }

      breaker.onFailure();
      if (attempt === opts.retries) throw err;

      const delay = backoffDelayMs(attempt, err.response?.headers?.['retry-after']);
      logger.warn({ step: opts.step, attempt, delay, status, correlationId: opts.correlationId }, 'AI transient failure — retrying');
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export const aiClient = {
  // §5.1 Quality guard POST /check
  async qualityGuard(imageKeys: string[], correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.qualityGuard}/check`, { image_keys: imageKeys }, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.fast),
      } as AxiosRequestConfig);
      // Normalize: guide expects { results:[{image_key, acceptable, issues, quality_score, blur_score,...}], passed, passed_count }
      return data;
    }, { retries: config.aiMaxRetries, correlationId, step: 'quality', service: AI_SERVICE_SLUGS.qualityGuard });
  },

  // §5.2 Object detection POST /detect
  async detect(imageKeys: string[], vertical: string, correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.objectDetection}/detect`, { image_keys: imageKeys, vertical }, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.standard),
      });
      return data as { items: any[], image_count:number, detected_count:number, failed_count:number, errors:any[] };
    }, { retries: config.aiMaxRetries, correlationId, step: 'detection', service: AI_SERVICE_SLUGS.objectDetection });
  },

  // §5.3 Attribute extraction POST /extract
  async extract(items: any[], correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.attributeExtractor}/extract`, { items }, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.standard),
      });
      return data as { items: any[] };
    }, { retries: config.aiMaxRetries, correlationId, step: 'attributes', service: AI_SERVICE_SLUGS.attributeExtractor });
  },

  // §5.4 Context inference POST /infer
  async inferContext(params: { vertical:string, climate?:any, culture?:string, occasion?:string, occupation?:string, season?:string }, correlationId: string) {
    return callWithRetry(async () => {
      // Guide contract: { vertical, climate:{temperature_c,humidity}, culture, occasion, occupation, season }
      const body: any = {
        vertical: params.vertical,
        climate: params.climate ?? { temperature_c: 29, humidity: 78 },
        culture: params.culture,
        occasion: params.occasion,
        occupation: params.occupation,
        season: params.season,
      };
      // also include legacy fields for backward compat with current context service if it expects temperature_c
      if (params.climate?.temperature_c != null) body.temperature_c = params.climate.temperature_c;
      const { data } = await axios.post(`${config.ai.contextInference}/infer`, body, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.fast),
      });
      return data;
    }, { retries: config.aiMaxRetries, correlationId, step: 'context', service: AI_SERVICE_SLUGS.contextInference });
  },

  // §5.5 Permutation engine POST /generate
  async generatePermutations(params: { vertical:string, items:any[], context:any, max_permutations?:number }, correlationId: string) {
    return callWithRetry(async () => {
      const body = {
        vertical: params.vertical,
        items: params.items,
        context: params.context,
        max_permutations: params.max_permutations ?? 20,
      };
      // Try new endpoint /generate first, fallback to legacy /permute
      try {
        const { data } = await axios.post(`${config.ai.permutationEngine}/generate`, body, {
          headers: headers(correlationId),
          timeout: t(config.aiTimeouts.standard),
        });
        return { permutations: data.permutations ?? [], count: data.count, truncated: data.truncated };
      } catch (e:any) {
        if (e.response?.status === 404) {
          const { data } = await axios.post(`${config.ai.permutationEngine}/permute`, {
            items: params.items, context: params.context, vertical: params.vertical, count: params.max_permutations ?? 20
          }, { headers: headers(correlationId), timeout: t(config.aiTimeouts.standard) });
          return { permutations: data.permutations ?? [], count: data.permutations?.length ?? 0, truncated: data.truncated ?? false };
        }
        throw e;
      }
    }, { retries: config.aiMaxRetries, correlationId, step: 'permutations', service: AI_SERVICE_SLUGS.permutationEngine });
  },

  // §5.6 Embedding engine POST /upsert & POST /search
  async upsertEmbeddings(vectors: Array<{id:string, embedding:number[], metadata:any}>, namespace:string, correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.embeddingEngine}/upsert`, { namespace, vectors }, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.fast),
      });
      return data;
    }, { retries: config.aiMaxRetries, correlationId, step: 'embeddings', service: AI_SERVICE_SLUGS.embeddingEngine });
  },

  async searchEmbeddings(embedding: number[], topK:number, namespace:string, filter:any, correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.embeddingEngine}/search`, { embedding, top_k: topK, namespace, filter }, {
        headers: headers(correlationId), timeout: t(config.aiTimeouts.fast),
      });
      return data;
    }, { retries: config.aiMaxRetries, correlationId, step: 'embedding_search', service: AI_SERVICE_SLUGS.embeddingEngine });
  },

  // §5.7 LLM reasoning POST /reason — slow path: real provider calls
  async reason(vertical:string, context:any, permutations:any[], correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.llmReasoning}/reason`, { vertical, context, permutations }, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.slow),
      });
      return data as { designs:any[], count:number };
    }, { retries: config.aiMaxRetries, correlationId, step: 'reasoning', service: AI_SERVICE_SLUGS.llmReasoning });
  },

  // §5.8 Mockup compositor POST /compose — slow path: image work + S3 round trips
  async compose(params: { layers: Array<{image_key:string, bbox:any}>, output_key:string, width?:number, height?:number, format?:string, background?:string }, correlationId: string) {
    return callWithRetry(async () => {
      const body: any = {
        layers: params.layers,
        output_key: params.output_key,
        width: params.width ?? 1200,
        height: params.height ?? 900,
        format: params.format ?? 'png',
        background: params.background ?? '#f7f4ef',
      };
      const { data } = await axios.post(`${config.ai.mockupCompositor}/compose`, body, {
        headers: headers(correlationId),
        timeout: t(config.aiTimeouts.slow),
      });
      // Returns { output_key, object_url, signed_url, width, height, layers }.
      // Persist output_key as the durable reference; signed_url expires.
      return data;
    }, { retries: config.aiMaxRetries, correlationId, step: 'mockups', service: AI_SERVICE_SLUGS.mockupCompositor });
  },

  /**
   * Aggregated gateway health — one request instead of eight.
   * Returns `production_ready` and a `degradations[]` naming every service
   * currently running a fallback. Requires the bearer token.
   */
  async gatewayHealth(): Promise<{
    production_ready: boolean;
    degradations: Array<{ service: string; reason: string }>;
    services: Record<string, any>;
    environment?: string;
    auth_required?: boolean;
  }> {
    const { data } = await axios.get(`${config.aiGatewayUrl}/health`, {
      timeout: t(config.aiTimeouts.health),
      headers: authHeaders(),
    });
    return data;
  },

  /** Gateway liveness — public, never requires a token. Good for warmers. */
  async livez(): Promise<boolean> {
    try {
      const { status } = await axios.get(`${config.aiGatewayUrl}/livez`, { timeout: t(config.aiTimeouts.health) });
      return status === 200;
    } catch {
      return false;
    }
  },

  /**
   * Is the AI tier serving prototype output rather than real model results?
   * Mark any session produced while this is true with `degraded: true` so those
   * results can be found and re-run later.
   */
  async isDegraded(): Promise<boolean> {
    try {
      const health = await this.gatewayHealth();
      return health.production_ready === false;
    } catch {
      return true; // unknown state — treat as degraded rather than claim quality
    }
  },

  /**
   * Per-service readiness. Uses the gateway's aggregated /health when a gateway
   * is configured (one request, and it is the authoritative signal — it knows
   * which fallbacks are active). Falls back to probing each service's /health
   * directly for split-host deployments.
   */
  async checkReadiness(): Promise<Record<string, any>> {
    const urls = aiUrlsBySlug({
      objectDetection:    config.ai.objectDetection,
      attributeExtractor: config.ai.attributeExtractor,
      embeddingEngine:    config.ai.embeddingEngine,
      permutationEngine:  config.ai.permutationEngine,
      llmReasoning:       config.ai.llmReasoning,
      mockupCompositor:   config.ai.mockupCompositor,
      qualityGuard:       config.ai.qualityGuard,
      contextInference:   config.ai.contextInference,
    });

    if (config.aiGatewayUrl) {
      try {
        const health = await this.gatewayHealth();
        const degradedBy = new Map(
          (health.degradations ?? []).map((d) => [d.service, d.reason] as const),
        );
        const results: Record<string, any> = {};
        for (const [name, url] of Object.entries(urls)) {
          const detail = health.services?.[name];
          if (!detail) {
            results[name] = { status: 'unavailable', url, error: 'not reported by gateway /health' };
            continue;
          }
          const reason = degradedBy.get(name);
          results[name] = reason
            ? { status: 'degraded', url, reason, detail }
            : { status: 'ok', url, detail };
        }
        return results;
      } catch (err: any) {
        // Gateway unreachable (or token rejected) — report it rather than
        // silently falling back to eight probes that would fail the same way.
        const error = err.response?.status === 401 || err.response?.status === 403
          ? `gateway rejected credentials (HTTP ${err.response.status}) — check AI_INTERNAL_TOKEN`
          : err.message;
        const results: Record<string, any> = {};
        for (const [name, url] of Object.entries(urls)) {
          results[name] = { status: 'unavailable', url, error };
        }
        return results;
      }
    }

    // Split-host deployment: probe each service directly.
    const results: Record<string,any> = {};
    await Promise.all(Object.entries(urls).map(async ([name, url])=>{
      try{
        const { data } = await axios.get(`${url}/health`, {
          timeout: t(config.aiTimeouts.health),
          headers: authHeaders(),
        });
        const modelLoaded = (data as any).model_loaded;
        const backend = (data as any).backend;
        const isProdReady = config.isDev ? true : (modelLoaded !== false && backend !== 'memory');
        results[name] = { status: isProdReady ? 'ok' : 'degraded', url, detail: data };
      } catch(err:any){
        results[name] = { status: 'unavailable', url, error: err.message };
      }
    }));
    return results;
  }
};

export { AiFallbackBlockedError };
