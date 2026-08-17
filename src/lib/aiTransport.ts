/**
 * Transport policy for calls to the Glimms AI gateway.
 *
 * One container runs all eight services on Render's shared tier, so the client
 * — not the server — is responsible for not overwhelming it:
 *
 *  - **Semaphore**: caps in-flight upstream requests per process. The gateway
 *    itself caps concurrency (MAX_CONCURRENT_UPSTREAM, default 16); exceeding
 *    it produces self-inflicted 502s.
 *  - **Circuit breaker**: after N consecutive failures the circuit opens and
 *    calls fail fast with a retryable error instead of hammering a sick
 *    instance. One half-open probe is allowed after the reset timeout.
 *  - **Typed errors**: a production-mode gateway answers 503 with a
 *    machine-readable `development_fallback_blocked` body rather than serving
 *    prototype output. That is a configuration problem, not a transient one,
 *    so it must never be retried.
 */

/** 503 `development_fallback_blocked` — the service refuses to return prototype output. */
export class AiFallbackBlockedError extends Error {
  readonly code = 'AI_FALLBACK_BLOCKED';
  readonly retryable = false;
  constructor(
    readonly service: string,
    readonly reason: string,
    readonly remedy: string,
  ) {
    super(`${service}: ${reason}`);
    this.name = 'AiFallbackBlockedError';
  }
}

/** The circuit for a service is open — fail fast, retry the job later. */
export class AiCircuitOpenError extends Error {
  readonly code = 'AI_CIRCUIT_OPEN';
  readonly retryable = true;
  constructor(readonly service: string, readonly openForMs: number) {
    super(`${service}: circuit open, retry in ${Math.ceil(openForMs / 1000)}s`);
    this.name = 'AiCircuitOpenError';
  }
}

/**
 * Recognises the gateway's machine-readable fallback-blocked body:
 *   { detail: { error: 'development_fallback_blocked', service, reason, remedy } }
 */
export function asFallbackBlocked(err: any): AiFallbackBlockedError | null {
  const detail = err?.response?.data?.detail;
  if (err?.response?.status !== 503 || !detail || typeof detail !== 'object') return null;
  if (detail.error !== 'development_fallback_blocked') return null;
  return new AiFallbackBlockedError(
    detail.service ?? 'unknown',
    detail.reason  ?? 'service is running a development fallback',
    detail.remedy  ?? 'configure the real model/provider for this service',
  );
}

/** Limits how many upstream requests this process has in flight at once. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Per-service consecutive-failure breaker. Deliberately small and synchronous
 * so it can be unit-tested without timers or a heavyweight dependency.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing  = false;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  state(): CircuitState {
    if (this.failures < this.threshold) return 'closed';
    if (this.now() - this.openedAt >= this.resetMs) return 'half-open';
    return 'open';
  }

  /** Throws AiCircuitOpenError when the circuit is open. */
  assertClosed(service: string): void {
    const state = this.state();
    if (state === 'open') {
      throw new AiCircuitOpenError(service, this.resetMs - (this.now() - this.openedAt));
    }
    if (state === 'half-open') this.probing = true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.probing  = false;
  }

  onFailure(): void {
    // A failed half-open probe re-opens the circuit for another full window.
    if (this.probing) {
      this.probing  = false;
      this.openedAt = this.now();
      return;
    }
    this.failures++;
    if (this.failures === this.threshold) this.openedAt = this.now();
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(service: string, threshold: number, resetMs: number): CircuitBreaker {
  let b = breakers.get(service);
  if (!b) {
    b = new CircuitBreaker(threshold, resetMs);
    breakers.set(service, b);
  }
  return b;
}

/** Test helper — clears breaker state between cases. */
export function resetBreakers(): void {
  breakers.clear();
}

/** Retry only transient/idempotent failures; never 4xx, never fallback-blocked. */
export function isRetryableStatus(status?: number): boolean {
  if (!status) return true; // connection reset / timeout / DNS
  return [408, 429, 500, 502, 503, 504].includes(status);
}

/** Exponential backoff with full jitter, honouring Retry-After when present. */
export function backoffDelayMs(attempt: number, retryAfterHeader?: string): number {
  const retryAfter = parseInt(retryAfterHeader ?? '', 10);
  if (!isNaN(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  const capped = Math.min(1000 * Math.pow(2, attempt), 8000);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}
