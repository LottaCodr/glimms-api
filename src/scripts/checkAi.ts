/**
 * Connectivity and fitness check for the AI tier.
 *
 *   npm run ai:check
 *
 * Against the hosted gateway it uses the aggregated endpoints — /livez (public),
 * /health and /readyz (bearer token) — and prints production_ready plus every
 * active degradation. Against a split-host deployment it probes each service's
 * /health directly.
 *
 * Exits non-zero if anything is unreachable or the credentials are rejected, so
 * it can gate a deploy. A degraded-but-reachable tier exits 0 and warns.
 *
 *   AI_GATEWAY_URL=https://glimms-ai.onrender.com \
 *   AI_INTERNAL_TOKEN=... npm run ai:check
 */
import axios from 'axios';
import {
  AI_SERVICE_KEYS,
  AI_SERVICE_SLUGS,
  resolveAiUrlsDetailed,
  resolveGatewayUrl,
} from '../config/aiUrls';

const TIMEOUT_MS = parseInt(process.env.AI_CHECK_TIMEOUT_MS ?? '90000', 10);
const token   = process.env.AI_INTERNAL_TOKEN ?? process.env.GLIMMS_INTERNAL_TOKEN;
const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

function fail(msg: string): never {
  console.error(`\n${msg}`);
  process.exit(1);
}

async function checkGateway(gateway: string): Promise<void> {
  console.log(`Gateway: ${gateway}`);
  console.log(`Token:   ${token ? 'set' : 'NOT SET — required once AI_INTERNAL_TOKEN is set on the deployment'}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms  (a sleeping instance takes 30-60s to wake)\n`);

  // 1. Liveness — public, no token.
  const started = Date.now();
  try {
    await axios.get(`${gateway}/livez`, { timeout: TIMEOUT_MS });
    console.log(`[  ok  ] /livez                (${Date.now() - started}ms)`);
  } catch (err: any) {
    fail(`[ FAIL ] /livez — gateway unreachable: ${err.code ?? err.message}`);
  }

  // 2. Aggregated health — needs the token when the deployment sets one.
  let health: any;
  try {
    ({ data: health } = await axios.get(`${gateway}/health`, { timeout: TIMEOUT_MS, headers }));
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      fail(`[ FAIL ] /health — HTTP ${status}. The gateway requires a bearer token; set AI_INTERNAL_TOKEN to the same value as on the deployment.`);
    }
    fail(`[ FAIL ] /health — ${err.code ?? err.message}`);
  }

  console.log(`[  ok  ] /health               environment=${health.environment ?? 'unknown'} auth_required=${health.auth_required ?? 'unknown'}`);

  // 3. Readiness — 503 unless every service is real.
  let readyStatus = 0;
  try {
    const r = await axios.get(`${gateway}/readyz`, { timeout: TIMEOUT_MS, headers, validateStatus: () => true });
    readyStatus = r.status;
  } catch (err: any) {
    fail(`[ FAIL ] /readyz — ${err.code ?? err.message}`);
  }
  console.log(`[${readyStatus === 200 ? '  ok  ' : ' warn '}] /readyz               HTTP ${readyStatus}`);

  // 4. Per-service state.
  console.log('');
  const degradedBy = new Map<string, string>(
    (health.degradations ?? []).map((d: any) => [d.service, d.reason]),
  );
  for (const key of AI_SERVICE_KEYS) {
    const slug   = AI_SERVICE_SLUGS[key];
    const detail = health.services?.[slug];
    const reason = degradedBy.get(slug);
    const mark   = !detail ? ' FAIL ' : reason ? ' warn ' : '  ok  ';
    console.log(`[${mark}] ${slug.padEnd(20)} ${gateway}/${slug}`);
    if (reason) console.log(`          degraded: ${reason}`);
    if (detail?.warning) console.log(`          ${detail.warning}`);
  }

  const productionReady = health.production_ready === true;
  console.log(`\nproduction_ready: ${productionReady}`);
  if (!productionReady) {
    console.log(
      'The tier is serving prototype output. Good for integration/staging; mark any\n' +
      'session produced from it as degraded, and mount real models/keys before real users.',
    );
  }

  const unreachable = AI_SERVICE_KEYS.filter((k) => !health.services?.[AI_SERVICE_SLUGS[k]]);
  if (unreachable.length) fail(`Unreachable: ${unreachable.map((k) => AI_SERVICE_SLUGS[k]).join(', ')}`);
}

async function checkSplitHosts(): Promise<void> {
  const resolved = resolveAiUrlsDetailed(process.env);
  console.log('Gateway: (none — per-service URLs)\n');

  const rows = await Promise.all(
    AI_SERVICE_KEYS.map(async (key) => {
      const { url, source } = resolved[key];
      const started = Date.now();
      try {
        const { data } = await axios.get(`${url}/health`, { timeout: TIMEOUT_MS, headers });
        return { name: AI_SERVICE_SLUGS[key], url, source, ok: true, ms: Date.now() - started, detail: JSON.stringify(data) };
      } catch (err: any) {
        return {
          name: AI_SERVICE_SLUGS[key], url, source, ok: false, ms: Date.now() - started,
          detail: err.response ? `HTTP ${err.response.status}` : (err.code ?? err.message),
        };
      }
    }),
  );

  for (const r of rows) {
    console.log(`[${r.ok ? '  ok  ' : ' FAIL '}] ${r.name.padEnd(20)} ${r.url}  (${r.source}, ${r.ms}ms)`);
    console.log(`          ${r.detail}`);
  }

  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} services reachable.`);
  if (failed.length) process.exit(1);
}

async function main(): Promise<void> {
  const gateway = resolveGatewayUrl(process.env);
  if (gateway) await checkGateway(gateway);
  else await checkSplitHosts();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
