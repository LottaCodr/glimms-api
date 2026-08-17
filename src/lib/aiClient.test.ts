/**
 * Verifies aiClient targets the correct gateway-prefixed URLs when the AI tier
 * is deployed as a single path-prefixed origin (AI_GATEWAY_URL), and that the
 * timeout multiplier is applied. axios is mocked — no network involved.
 *
 * config/ reads process.env at import time, so these tests re-require modules
 * after jest.resetModules() to exercise different env — hence require() here.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const GATEWAY = 'https://glimms-ai.onrender.com';

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

describe('aiClient with AI_GATEWAY_URL', () => {
  const OLD_ENV = process.env;
  let axios: any;
  let aiClient: any;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...OLD_ENV,
      AI_GATEWAY_URL: GATEWAY,
      AI_INTERNAL_TOKEN: 'tok_secret',
      AI_TIMEOUT_MULTIPLIER: '3',
      AI_MAX_RETRIES: '0',
      JWT_SECRET: '0123456789012345678901234567890123456789',
      REFRESH_TOKEN_SECRET: '0123456789012345678901234567890123456789',
    };
    // Per-service overrides must not leak in from the developer's shell/.env.
    delete process.env.AI_OBJECT_DETECTION_URL;
    delete process.env.AI_QUALITY_GUARD_URL;
    delete process.env.AI_LLM_REASONING_URL;

    axios = require('axios').default;
    axios.post.mockReset();
    axios.get.mockReset();
    aiClient = require('./aiClient').aiClient;
  });

  afterAll(() => { process.env = OLD_ENV; });

  it('posts quality checks to <gateway>/quality-guard/check', async () => {
    axios.post.mockResolvedValue({ data: { results: [], passed: true } });
    await aiClient.qualityGuard(['uploads/a.jpg'], 'cid-1');

    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe(`${GATEWAY}/quality-guard/check`);
    expect(body).toEqual({ image_keys: ['uploads/a.jpg'] });
    expect(opts.headers['X-Correlation-ID']).toBe('cid-1');
    expect(opts.timeout).toBe(60_000); // 20s fast-class base x AI_TIMEOUT_MULTIPLIER=3
    expect(opts.headers['Authorization']).toBe('Bearer tok_secret');
  });

  it('posts detection to <gateway>/object-detection/detect', async () => {
    axios.post.mockResolvedValue({ data: { items: [], image_count: 0, detected_count: 0 } });
    await aiClient.detect(['uploads/a.jpg'], 'wardrobe', 'cid-2');

    expect(axios.post.mock.calls[0][0]).toBe(`${GATEWAY}/object-detection/detect`);
    expect(axios.post.mock.calls[0][1]).toEqual({ image_keys: ['uploads/a.jpg'], vertical: 'wardrobe' });
  });

  it('posts reasoning to <gateway>/llm-reasoning/reason', async () => {
    axios.post.mockResolvedValue({ data: { designs: [], count: 0 } });
    await aiClient.reason('wardrobe', {}, [], 'cid-3');

    expect(axios.post.mock.calls[0][0]).toBe(`${GATEWAY}/llm-reasoning/reason`);
  });

  it('builds URLs with no double slash', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await aiClient.extract([], 'cid-4');

    const url: string = axios.post.mock.calls[0][0];
    expect(url).toBe(`${GATEWAY}/attribute-extractor/extract`);
    expect(url.replace('https://', '')).not.toContain('//');
  });

  it('reports an unreachable gateway as unavailable instead of throwing', async () => {
    axios.get.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const results = await aiClient.checkReadiness();

    expect(results['object-detection'].status).toBe('unavailable');
    expect(results['object-detection'].error).toContain('ENOTFOUND');
  });

  it('sends the bearer token on health probes too — the gateway protects them', async () => {
    axios.get.mockResolvedValue({ data: { production_ready: true, degradations: [], services: {} } });
    await aiClient.gatewayHealth();

    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toBe(`${GATEWAY}/health`);
    expect(opts.headers.Authorization).toBe('Bearer tok_secret');
  });

  it('does not send the token to /livez, which is public', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { status: 'ok' } });
    await expect(aiClient.livez()).resolves.toBe(true);

    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toBe(`${GATEWAY}/livez`);
    expect(opts.headers).toBeUndefined();
  });

  it('caps any single call at GLIMMS_TIMEOUT_MS', async () => {
    process.env.GLIMMS_TIMEOUT_MS = '60000';
    jest.resetModules();
    axios = require('axios').default;
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { designs: [], count: 0 } });
    const client = require('./aiClient').aiClient;

    await client.reason('wardrobe', {}, [], 'cid');
    // slow class would be 120s x3, but the ceiling wins
    expect(axios.post.mock.calls[0][2].timeout).toBe(60_000);
    delete process.env.GLIMMS_TIMEOUT_MS;
  });

  describe('development_fallback_blocked', () => {
    const blocked = {
      response: {
        status: 503,
        data: {
          detail: {
            error: 'development_fallback_blocked',
            service: 'object-detection',
            reason: 'no detection model is loaded; results would be prototypes',
            remedy: 'mount a YOLOv8 ONNX model and set MODEL_PATH/MODEL_LABELS',
          },
        },
      },
    };

    it('throws a typed error carrying service, reason and remedy', async () => {
      axios.post.mockRejectedValue(blocked);
      await expect(aiClient.detect(['k'], 'wardrobe', 'cid')).rejects.toMatchObject({
        code: 'AI_FALLBACK_BLOCKED',
        service: 'object-detection',
        retryable: false,
      });
    });

    it('does not retry it — it is a configuration problem, not a blip', async () => {
      process.env.AI_MAX_RETRIES = '3';
      jest.resetModules();
      axios = require('axios').default;
      axios.post.mockReset();
      axios.post.mockRejectedValue(blocked);
      const client = require('./aiClient').aiClient;

      await expect(client.detect(['k'], 'wardrobe', 'cid')).rejects.toMatchObject({ code: 'AI_FALLBACK_BLOCKED' });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('readiness via the gateway', () => {
    const health = {
      production_ready: false,
      environment: 'development',
      degradations: [
        { service: 'object-detection', reason: 'no YOLO model is mounted; detections are deterministic prototypes' },
        { service: 'embedding-engine', reason: 'vectors live in process memory and are lost on restart' },
      ],
      services: {
        'object-detection': { status: 'ok', model_loaded: false },
        'attribute-extractor': { status: 'ok' },
        'embedding-engine': { status: 'ok', backend: 'memory' },
        'permutation-engine': { status: 'ok' },
        'llm-reasoning': { status: 'ok' },
        'mockup-compositor': { status: 'ok' },
        'quality-guard': { status: 'ok' },
        'context-inference': { status: 'ok' },
      },
    };

    it('uses one aggregated call instead of eight probes', async () => {
      axios.get.mockResolvedValue({ data: health });
      const results = await aiClient.checkReadiness();

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get.mock.calls[0][0]).toBe(`${GATEWAY}/health`);
      expect(Object.keys(results)).toHaveLength(8);
    });

    it("trusts the gateway's degradations list", async () => {
      axios.get.mockResolvedValue({ data: health });
      const results = await aiClient.checkReadiness();

      expect(results['object-detection'].status).toBe('degraded');
      expect(results['object-detection'].reason).toContain('prototypes');
      expect(results['embedding-engine'].status).toBe('degraded');
      expect(results['quality-guard'].status).toBe('ok');
    });

    it('reports a rejected token as a credentials problem, not a mystery outage', async () => {
      axios.get.mockRejectedValue({ response: { status: 401 }, message: 'Request failed' });
      const results = await aiClient.checkReadiness();

      expect(results['llm-reasoning'].status).toBe('unavailable');
      expect(results['llm-reasoning'].error).toContain('AI_INTERNAL_TOKEN');
    });

    it('isDegraded() reflects production_ready, and errs toward degraded', async () => {
      axios.get.mockResolvedValue({ data: health });
      await expect(aiClient.isDegraded()).resolves.toBe(true);

      axios.get.mockResolvedValue({ data: { ...health, production_ready: true, degradations: [] } });
      await expect(aiClient.isDegraded()).resolves.toBe(false);

      axios.get.mockRejectedValue(new Error('unreachable'));
      await expect(aiClient.isDegraded()).resolves.toBe(true);
    });
  });
});

/**
 * Split-host deployment (docker-compose / k8s): no gateway, so readiness has to
 * probe each service's own /health and infer degradation from the payload.
 */
describe('aiClient without a gateway', () => {
  const OLD_ENV = process.env;
  let axios: any;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...OLD_ENV,
      JWT_SECRET: '0123456789012345678901234567890123456789',
      REFRESH_TOKEN_SECRET: '0123456789012345678901234567890123456789',
      NODE_ENV: 'production',
      AI_INTERNAL_TOKEN: 'tok_secret',
    };
    delete process.env.AI_GATEWAY_URL;
    delete process.env.GLIMMS_BASE_URL;
    axios = require('axios').default;
    axios.get.mockReset();
  });

  afterAll(() => { process.env = OLD_ENV; });

  it('probes each service directly, with the token attached', async () => {
    axios.get.mockResolvedValue({ data: { status: 'ok' } });
    const client = require('./aiClient').aiClient;
    const results = await client.checkReadiness();

    expect(axios.get).toHaveBeenCalledTimes(8);
    expect(axios.get.mock.calls[0][0]).toMatch(/\/health$/);
    expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer tok_secret');
    expect(results['quality-guard'].url).toBe('http://localhost:8007');
  });

  it('infers degradation from model_loaded / in-memory backends in production', async () => {
    // Split-host URLs are host:port, not service-name paths.
    axios.get.mockImplementation(async (url: string) => {
      if (url.includes(':8003')) return { data: { status: 'ok', backend: 'memory' } };      // embedding-engine
      if (url.includes(':8001')) return { data: { status: 'ok', model_loaded: false } };    // object-detection
      return { data: { status: 'ok' } };
    });
    const client = require('./aiClient').aiClient;
    const results = await client.checkReadiness();

    expect(results['embedding-engine'].status).toBe('degraded');
    expect(results['object-detection'].status).toBe('degraded');
    expect(results['llm-reasoning'].status).toBe('ok');
  });
});
