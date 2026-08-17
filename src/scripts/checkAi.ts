/**
 * Connectivity check for the AI tier.
 *
 *   npm run ai:check
 *
 * Prints the resolved base URL for each of the eight services (and how it was
 * resolved), then GETs `<base>/health` and reports the result. Exits non-zero
 * if any service is unreachable, so it can gate a deploy.
 *
 * Against the Render gateway:
 *   AI_GATEWAY_URL=https://glimms-ai.onrender.com npm run ai:check
 */
import axios from 'axios';
import {
  AI_SERVICE_KEYS,
  AI_SERVICE_SLUGS,
  resolveAiUrlsDetailed,
} from '../config/aiUrls';

const TIMEOUT_MS = parseInt(process.env.AI_CHECK_TIMEOUT_MS ?? '60000', 10);

async function main(): Promise<void> {
  const resolved = resolveAiUrlsDetailed(process.env);
  const gateway  = process.env.AI_GATEWAY_URL?.trim();

  console.log(gateway ? `Gateway: ${gateway}` : 'Gateway: (none — per-service URLs)');
  console.log(`Timeout: ${TIMEOUT_MS}ms  (hosted free tiers cold-start slowly)\n`);

  const token   = process.env.AI_INTERNAL_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const rows = await Promise.all(
    AI_SERVICE_KEYS.map(async (key) => {
      const { url, source } = resolved[key];
      const started = Date.now();
      try {
        const { data } = await axios.get(`${url}/health`, { timeout: TIMEOUT_MS, headers });
        return {
          name: AI_SERVICE_SLUGS[key],
          url,
          source,
          ok: true,
          ms: Date.now() - started,
          detail: typeof data === 'object' ? JSON.stringify(data) : String(data),
        };
      } catch (err: any) {
        return {
          name: AI_SERVICE_SLUGS[key],
          url,
          source,
          ok: false,
          ms: Date.now() - started,
          detail: err.response
            ? `HTTP ${err.response.status}`
            : (err.code ?? err.message),
        };
      }
    }),
  );

  for (const r of rows) {
    const mark = r.ok ? '  ok  ' : ' FAIL ';
    console.log(`[${mark}] ${r.name.padEnd(20)} ${r.url}  (${r.source}, ${r.ms}ms)`);
    console.log(`          ${r.detail}`);
  }

  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} services reachable.`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
