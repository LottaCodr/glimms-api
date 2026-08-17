import {
  AI_SERVICE_KEYS,
  AI_SERVICE_SLUGS,
  aiUrlsBySlug,
  normalizeBaseUrl,
  resolveAiUrls,
  resolveAiUrlsDetailed,
} from './aiUrls';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes so `${base}/detect` stays single-slashed', () => {
    expect(normalizeBaseUrl('https://glimms-ai.onrender.com/')).toBe('https://glimms-ai.onrender.com');
    expect(normalizeBaseUrl('https://host/object-detection///')).toBe('https://host/object-detection');
    expect(normalizeBaseUrl('  http://localhost:8001  ')).toBe('http://localhost:8001');
  });
});

describe('resolveAiUrls', () => {
  it('falls back to localhost ports when nothing is configured', () => {
    const urls = resolveAiUrls({});
    expect(urls.objectDetection).toBe('http://localhost:8001');
    expect(urls.attributeExtractor).toBe('http://localhost:8002');
    expect(urls.embeddingEngine).toBe('http://localhost:8003');
    expect(urls.permutationEngine).toBe('http://localhost:8004');
    expect(urls.llmReasoning).toBe('http://localhost:8005');
    expect(urls.mockupCompositor).toBe('http://localhost:8006');
    expect(urls.qualityGuard).toBe('http://localhost:8007');
    expect(urls.contextInference).toBe('http://localhost:8008');
  });

  it('derives path-prefixed URLs from a single gateway (Render deployment)', () => {
    const urls = resolveAiUrls({ AI_GATEWAY_URL: 'https://glimms-ai.onrender.com' });
    expect(urls.objectDetection).toBe('https://glimms-ai.onrender.com/object-detection');
    expect(urls.qualityGuard).toBe('https://glimms-ai.onrender.com/quality-guard');
    expect(urls.contextInference).toBe('https://glimms-ai.onrender.com/context-inference');
  });

  it('tolerates a gateway URL with a trailing slash', () => {
    const urls = resolveAiUrls({ AI_GATEWAY_URL: 'https://glimms-ai.onrender.com/' });
    expect(urls.llmReasoning).toBe('https://glimms-ai.onrender.com/llm-reasoning');
    expect(urls.llmReasoning).not.toContain('//llm-reasoning');
  });

  it('gives every service a distinct URL (no copy-paste collisions)', () => {
    const urls = resolveAiUrls({ AI_GATEWAY_URL: 'https://glimms-ai.onrender.com' });
    const values = AI_SERVICE_KEYS.map((k) => urls[k]);
    expect(new Set(values).size).toBe(AI_SERVICE_KEYS.length);
  });

  it('lets a per-service URL override the gateway', () => {
    const urls = resolveAiUrls({
      AI_GATEWAY_URL: 'https://glimms-ai.onrender.com',
      AI_EMBEDDING_ENGINE_URL: 'http://embedding-engine:8003',
    });
    expect(urls.embeddingEngine).toBe('http://embedding-engine:8003');
    expect(urls.objectDetection).toBe('https://glimms-ai.onrender.com/object-detection');
  });

  it('ignores blank env values instead of producing an empty base URL', () => {
    const urls = resolveAiUrls({
      AI_GATEWAY_URL: 'https://glimms-ai.onrender.com',
      AI_LLM_REASONING_URL: '   ',
    });
    expect(urls.llmReasoning).toBe('https://glimms-ai.onrender.com/llm-reasoning');
  });

  it('reports how each URL was resolved', () => {
    const detailed = resolveAiUrlsDetailed({
      AI_GATEWAY_URL: 'https://glimms-ai.onrender.com',
      AI_QUALITY_GUARD_URL: 'http://quality-guard:8007',
    });
    expect(detailed.qualityGuard.source).toBe('service-env');
    expect(detailed.objectDetection.source).toBe('gateway');
    expect(resolveAiUrlsDetailed({}).objectDetection.source).toBe('default');
  });
});

describe('aiUrlsBySlug', () => {
  it('keys URLs by the slug the gateway and /health responses use', () => {
    const urls = resolveAiUrls({ AI_GATEWAY_URL: 'https://glimms-ai.onrender.com' });
    const bySlug = aiUrlsBySlug(urls);
    expect(Object.keys(bySlug).sort()).toEqual(
      AI_SERVICE_KEYS.map((k) => AI_SERVICE_SLUGS[k]).sort(),
    );
    expect(bySlug['mockup-compositor']).toBe('https://glimms-ai.onrender.com/mockup-compositor');
  });
});
