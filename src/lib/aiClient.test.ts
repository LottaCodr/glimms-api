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
      AI_TIMEOUT_MULTIPLIER: '3',
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
    expect(opts.timeout).toBe(45_000); // 15s base x AI_TIMEOUT_MULTIPLIER=3
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

  it('checks readiness on each prefixed /health and reports the URL used', async () => {
    axios.get.mockResolvedValue({ data: { status: 'ok' } });
    const results = await aiClient.checkReadiness();

    const urls = axios.get.mock.calls.map((c: any[]) => c[0]).sort();
    expect(urls).toEqual([
      `${GATEWAY}/attribute-extractor/health`,
      `${GATEWAY}/context-inference/health`,
      `${GATEWAY}/embedding-engine/health`,
      `${GATEWAY}/llm-reasoning/health`,
      `${GATEWAY}/mockup-compositor/health`,
      `${GATEWAY}/object-detection/health`,
      `${GATEWAY}/permutation-engine/health`,
      `${GATEWAY}/quality-guard/health`,
    ]);
    expect(results['quality-guard'].url).toBe(`${GATEWAY}/quality-guard`);
  });

  it('marks a service degraded in production when it runs a fallback backend', async () => {
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    axios = require('axios').default;
    axios.get.mockReset();
    axios.get.mockImplementation(async (url: string) =>
      url.includes('embedding-engine')
        ? { data: { status: 'ok', backend: 'memory' } }
        : { data: { status: 'ok' } });
    const client = require('./aiClient').aiClient;

    const results = await client.checkReadiness();
    expect(results['embedding-engine'].status).toBe('degraded');
    expect(results['llm-reasoning'].status).toBe('ok');
  });

  it('reports an unreachable service as unavailable instead of throwing', async () => {
    axios.get.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const results = await aiClient.checkReadiness();

    expect(results['object-detection'].status).toBe('unavailable');
    expect(results['object-detection'].error).toContain('ENOTFOUND');
  });
});
