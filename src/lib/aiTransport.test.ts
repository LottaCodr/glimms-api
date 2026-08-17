import {
  AiCircuitOpenError,
  AiFallbackBlockedError,
  CircuitBreaker,
  Semaphore,
  asFallbackBlocked,
  backoffDelayMs,
  isRetryableStatus,
} from './aiTransport';

describe('asFallbackBlocked', () => {
  const body = {
    detail: {
      error: 'development_fallback_blocked',
      service: 'object-detection',
      reason: 'no detection model is loaded; results would be prototypes',
      remedy: 'mount a YOLOv8 ONNX model and set MODEL_PATH/MODEL_LABELS',
    },
  };

  it('recognises the gateway 503 fallback-blocked body', () => {
    const err = asFallbackBlocked({ response: { status: 503, data: body } });
    expect(err).toBeInstanceOf(AiFallbackBlockedError);
    expect(err!.service).toBe('object-detection');
    expect(err!.remedy).toContain('YOLOv8');
    expect(err!.retryable).toBe(false);
  });

  it('ignores ordinary 503s, which are transient and should be retried', () => {
    expect(asFallbackBlocked({ response: { status: 503, data: { detail: 'upstream timeout' } } })).toBeNull();
    expect(asFallbackBlocked({ response: { status: 503, data: {} } })).toBeNull();
    expect(asFallbackBlocked({ code: 'ECONNRESET' })).toBeNull();
  });

  it('ignores a fallback-blocked shape on a non-503 status', () => {
    expect(asFallbackBlocked({ response: { status: 400, data: body } })).toBeNull();
  });
});

describe('isRetryableStatus', () => {
  it('retries transient statuses and network failures', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true); // connection reset / timeout
  });

  it('never retries client errors', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('honours Retry-After when the gateway sends one', () => {
    expect(backoffDelayMs(0, '5')).toBe(5000);
  });

  it('caps a hostile Retry-After', () => {
    expect(backoffDelayMs(0, '86400')).toBe(30_000);
  });

  it('grows exponentially with jitter, within bounds', () => {
    for (const attempt of [0, 1, 2, 3]) {
      const cap = Math.min(1000 * Math.pow(2, attempt), 8000);
      for (let i = 0; i < 25; i++) {
        const d = backoffDelayMs(attempt);
        expect(d).toBeGreaterThanOrEqual(cap / 2);
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('produces varied delays so retries do not stampede', () => {
    const seen = new Set(Array.from({ length: 40 }, () => backoffDelayMs(3)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('Semaphore', () => {
  it('never exceeds the configured concurrency', async () => {
    const sem = new Semaphore(3);
    let running = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: 20 }, () => sem.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    })));

    expect(peak).toBeLessThanOrEqual(3);
    expect(running).toBe(0);
  });

  it('releases its slot when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    expect(sem.inFlight).toBe(0);
  });
});

describe('CircuitBreaker', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => { now = 1_000_000; });

  it('stays closed below the failure threshold', () => {
    const b = new CircuitBreaker(3, 30_000, clock);
    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe('closed');
    expect(() => b.assertClosed('llm-reasoning')).not.toThrow();
  });

  it('opens after N consecutive failures and fails fast', () => {
    const b = new CircuitBreaker(3, 30_000, clock);
    b.onFailure(); b.onFailure(); b.onFailure();
    expect(b.state()).toBe('open');
    expect(() => b.assertClosed('llm-reasoning')).toThrow(AiCircuitOpenError);
  });

  it('marks the failure as retryable so the job can be requeued', () => {
    const b = new CircuitBreaker(1, 30_000, clock);
    b.onFailure();
    try {
      b.assertClosed('llm-reasoning');
      throw new Error('expected throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AiCircuitOpenError);
      expect(err.retryable).toBe(true);
      expect(err.message).toContain('llm-reasoning');
    }
  });

  it('a success resets the failure count', () => {
    const b = new CircuitBreaker(3, 30_000, clock);
    b.onFailure(); b.onFailure();
    b.onSuccess();
    b.onFailure();
    expect(b.state()).toBe('closed');
  });

  it('half-opens after the reset window and closes on a successful probe', () => {
    const b = new CircuitBreaker(2, 30_000, clock);
    b.onFailure(); b.onFailure();
    expect(b.state()).toBe('open');

    now += 30_000;
    expect(b.state()).toBe('half-open');
    expect(() => b.assertClosed('llm-reasoning')).not.toThrow();

    b.onSuccess();
    expect(b.state()).toBe('closed');
  });

  it('re-opens for a full window when the half-open probe fails', () => {
    const b = new CircuitBreaker(2, 30_000, clock);
    b.onFailure(); b.onFailure();
    now += 30_000;
    b.assertClosed('llm-reasoning'); // probe
    b.onFailure();                   // probe failed

    expect(b.state()).toBe('open');
    now += 29_000;
    expect(b.state()).toBe('open');
    now += 1_000;
    expect(b.state()).toBe('half-open');
  });
});
