/**
 * Aggregation of per-service AI readiness into one overall verdict.
 *
 * Three per-service states, produced by `aiClient.checkReadiness()`:
 *   ok           — reachable, running its real backend
 *   degraded     — reachable, but on a fallback backend (model_loaded:false,
 *                  in-memory vector store instead of Pinecone, offline LLM)
 *   unavailable  — not reachable at all
 *
 * `allowDegraded` (env AI_ALLOW_DEGRADED) exists because the lightweight
 * all-in-one build intentionally runs deterministic offline fallbacks: those
 * deployments are genuinely serving traffic and should not fail readiness.
 * An unreachable service always fails readiness regardless.
 */

export type ServiceStatus = 'ok' | 'degraded' | 'unavailable';

export interface ReadinessSummary {
  status: ServiceStatus;
  ready:  boolean;
}

export function summarizeReadiness(
  checks: Record<string, { status: string }>,
  opts: { allowDegraded: boolean },
): ReadinessSummary {
  const statuses = Object.values(checks).map((c) => c.status);

  if (statuses.length === 0) return { status: 'unavailable', ready: false };

  const anyDown = statuses.some((s) => s === 'unavailable');
  const allOk   = statuses.every((s) => s === 'ok');

  const status: ServiceStatus = allOk ? 'ok' : anyDown ? 'unavailable' : 'degraded';
  const ready = allOk || (opts.allowDegraded && !anyDown);

  return { status, ready };
}
