import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { logger } from './logger';

/**
 * Centralized AI service HTTP client per backend implementation guide §4 & §5
 * - Private service DNS (config.ai.*) — never localhost in prod
 * - Service-to-service auth via AI_INTERNAL_TOKEN
 * - Correlation/Request IDs
 * - Timeouts, retries with exponential backoff
 */

export interface AiCallOpts {
  correlationId: string;
  requestId?: string;
  timeout?: number;
  retries?: number;
}

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

async function callWithRetry<T>(fn: () => Promise<T>, opts: { retries: number; correlationId: string; step: string }): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err.response?.status;
      const isTransient = !status || [408,429,500,502,503,504].includes(status);
      // Never retry validation/auth/not-found
      if (status && [400,401,403,404,422].includes(status)) {
        logger.warn({ step: opts.step, status, correlationId: opts.correlationId }, 'AI service non-retryable error');
        throw err;
      }
      if (!isTransient || attempt === opts.retries) throw err;
      const backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random()*500, 8000);
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] ?? '', 10);
      const delay = !isNaN(retryAfter) ? retryAfter*1000 : backoff;
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
        timeout: 15_000,
      } as AxiosRequestConfig);
      // Normalize: guide expects { results:[{image_key, acceptable, issues, quality_score, blur_score,...}], passed, passed_count }
      return data;
    }, { retries: 2, correlationId, step: 'quality' });
  },

  // §5.2 Object detection POST /detect
  async detect(imageKeys: string[], vertical: string, correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.objectDetection}/detect`, { image_keys: imageKeys, vertical }, {
        headers: headers(correlationId),
        timeout: 30_000,
      });
      return data as { items: any[], image_count:number, detected_count:number, failed_count:number, errors:any[] };
    }, { retries: 2, correlationId, step: 'detection' });
  },

  // §5.3 Attribute extraction POST /extract
  async extract(items: any[], correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.attributeExtractor}/extract`, { items }, {
        headers: headers(correlationId),
        timeout: 30_000,
      });
      return data as { items: any[] };
    }, { retries: 2, correlationId, step: 'attributes' });
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
        timeout: 5_000,
      });
      return data;
    }, { retries: 1, correlationId, step: 'context' });
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
          timeout: 30_000,
        });
        return { permutations: data.permutations ?? data.permutations ?? [], count: data.count, truncated: data.truncated };
      } catch (e:any) {
        if (e.response?.status === 404) {
          const { data } = await axios.post(`${config.ai.permutationEngine}/permute`, {
            items: params.items, context: params.context, vertical: params.vertical, count: params.max_permutations ?? 20
          }, { headers: headers(correlationId), timeout: 30_000 });
          return { permutations: data.permutations ?? [], count: data.permutations?.length ?? 0, truncated: data.truncated ?? false };
        }
        throw e;
      }
    }, { retries: 1, correlationId, step: 'permutations' });
  },

  // §5.6 Embedding engine POST /upsert & POST /search
  async upsertEmbeddings(vectors: Array<{id:string, embedding:number[], metadata:any}>, namespace:string, correlationId: string) {
    return callWithRetry(async () => {
      // Try guide shape first
      try {
        const { data } = await axios.post(`${config.ai.embeddingEngine}/upsert`, { namespace, vectors }, {
          headers: headers(correlationId),
          timeout: 10_000,
        });
        return data;
      } catch (e:any) {
        if (e.response?.status === 404 || e.response?.status === 400) {
          // Fallback: legacy per-item upsert for backward compat — handled by worker loop
          throw e;
        }
        throw e;
      }
    }, { retries: 1, correlationId, step: 'embeddings' });
  },

  async searchEmbeddings(embedding: number[], topK:number, namespace:string, filter:any, correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.embeddingEngine}/search`, { embedding, top_k: topK, namespace, filter }, {
        headers: headers(correlationId), timeout: 10_000,
      });
      return data;
    }, { retries: 1, correlationId, step: 'embedding_search' });
  },

  // §5.7 LLM reasoning POST /reason
  async reason(vertical:string, context:any, permutations:any[], correlationId: string) {
    return callWithRetry(async () => {
      const { data } = await axios.post(`${config.ai.llmReasoning}/reason`, { vertical, context, permutations }, {
        headers: headers(correlationId),
        timeout: 60_000,
      });
      return data as { designs:any[], count:number };
    }, { retries: 2, correlationId, step: 'reasoning' });
  },

  // §5.8 Mockup compositor POST /compose
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
      // Try guide shape /compose, fallback to legacy { designs, image_keys }
      try {
        const { data } = await axios.post(`${config.ai.mockupCompositor}/compose`, body, {
          headers: headers(correlationId),
          timeout: 90_000,
        });
        // guide returns { output_key, url, width, height, layers }
        if (data.output_key) return data;
        // if legacy shape, return as is
        return data;
      } catch (e:any) {
        if (e.response?.status === 404) {
          // legacy fallback — not ideal, but permit
          throw e;
        }
        throw e;
      }
    }, { retries: 1, correlationId, step: 'mockups' });
  },

  // Helper to check readiness per guide §4
  async checkReadiness(): Promise<Record<string, any>> {
    const services: Record<string,string> = {
      'object-detection': config.ai.objectDetection,
      'attribute-extractor': config.ai.attributeExtractor,
      'embedding-engine': config.ai.embeddingEngine,
      'permutation-engine': config.ai.permutationEngine,
      'llm-reasoning': config.ai.llmReasoning,
      'mockup-compositor': config.ai.mockupCompositor,
      'quality-guard': config.ai.qualityGuard,
      'context-inference': config.ai.contextInference,
    };
    const results: Record<string,any> = {};
    await Promise.all(Object.entries(services).map(async ([name, url])=>{
      try{
        const { data } = await axios.get(`${url}/health`, { timeout: 2000 });
        const modelLoaded = (data as any).model_loaded;
        const backend = (data as any).backend;
        const isProdReady = config.isDev ? true : (modelLoaded !== false && backend !== 'memory');
        results[name] = { status: isProdReady ? 'ok' : 'degraded', detail: data };
      } catch(err:any){
        results[name] = { status: 'unavailable', error: err.message };
      }
    }));
    return results;
  }
};
