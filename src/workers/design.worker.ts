import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { redis } from '../lib/redis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { designsService } from '../services/designs.service';
import { catalogService } from '../services/catalog.service';
import { notificationsService } from '../services/notifications.service';
import { DesignJobData } from '../lib/queue';
import type { Server as IOServer } from 'socket.io';

// io is set once by server.ts after Socket.IO is initialised
let _io: IOServer | null = null;

export function setIO(io: IOServer) {
  _io = io;
}

function emit(jobId: string, event: string, data: Record<string, unknown>) {
  _io?.to(`job:${jobId}`).emit(event, data);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function runPipeline(job: Job<DesignJobData>): Promise<void> {
  const { jobId, userId, vertical, imageKeys, contextData } = job.data;

  logger.info({ jobId, userId, vertical }, '▶  Design pipeline started');

  try {
    // ── 1. Mark as processing ─────────────────────────────────────────────────
    await designsService.updateJobStatus(jobId, 'processing');
    emit(jobId, 'job:update', { status: 'processing', step: 'detecting', progress: 10 });

    // ── 2. Object detection ───────────────────────────────────────────────────
    const detectionRes = await axios.post(
      `${config.ai.objectDetection}/detect`,
      { image_keys: imageKeys, vertical },
      { timeout: 30_000 },
    );
    const detectedItems: Record<string, unknown>[] = detectionRes.data.items ?? [];
    logger.info({ jobId, count: detectedItems.length }, 'Detection complete');

    if (!detectedItems.length) {
      // No items found — complete with empty result rather than failing
      const emptyResult = {
        designs:    [],
        vertical,
        itemCount:  0,
        message:    'No items detected. Try re-scanning with better lighting.',
        generatedAt: new Date().toISOString(),
      };
      await designsService.updateJobStatus(jobId, 'completed', emptyResult);
      emit(jobId, 'job:complete', emptyResult);
      return;
    }

    emit(jobId, 'job:update', {
      status:    'processing',
      step:      'extracting',
      progress:  25,
      itemCount: detectedItems.length,
    });

    // ── 3. Attribute extraction ───────────────────────────────────────────────
    const attrRes = await axios.post(
      `${config.ai.attributeExtractor}/extract`,
      { items: detectedItems },
      { timeout: 30_000 },
    );
    const enrichedItems: Record<string, unknown>[] = attrRes.data.items ?? [];
    logger.info({ jobId }, 'Attribute extraction complete');

    emit(jobId, 'job:update', { status: 'processing', step: 'embedding', progress: 40 });

    // ── 4. Upsert embeddings to Pinecone (fire-and-forget — non-blocking) ──────
    for (const item of enrichedItems) {
      const embedding = item['embedding'] as number[] | undefined;
      if (embedding?.length) {
        axios.post(
          `${config.ai.embeddingEngine}/upsert`,
          {
            item_id:   `${userId}:${item['label']}:${Date.now()}`,
            user_id:   userId,
            embedding,
            metadata:  {
              vertical,
              label:    item['label'],
              category: item['category'],
              userId,
            },
          },
          { timeout: 10_000 },
        ).catch(e => logger.warn({ err: e.message }, 'Embedding upsert failed (non-fatal)'));
      }
    }

    // ── 5. Save detected items to user's catalog ──────────────────────────────
    const catalogItems = enrichedItems.map(item => ({
      vertical,
      label:       item['label']    as string,
      category:    item['category'] as string,
      color:       (item['color']   as Record<string, unknown>) ?? { dominant: { hex: '#888888', rgb: { r: 136, g: 136, b: 136 } } },
      imageKey:    (item['image_key'] as string) ?? imageKeys[0] ?? '',
      confidence:  (item['confidence'] as number) ?? 0.8,
      texture:     (item['texture'] as any)?.roughness,
      pattern:     (item['texture'] as any)?.pattern,
      tags:        [],
      styleTags:   (item['style_tags'] as string[]) ?? [],
      attributes:  { bbox: item['bbox'] },
    }));

    await catalogService.bulkCreate(userId, catalogItems)
      .catch(e => logger.warn({ err: e.message }, 'Catalog bulk-create failed (non-fatal)'));

    emit(jobId, 'job:update', { status: 'processing', step: 'permutating', progress: 55 });

    // ── 6. Permutation engine ─────────────────────────────────────────────────
    const permRes = await axios.post(
      `${config.ai.permutationEngine}/permute`,
      {
        items:    enrichedItems,
        context:  contextData,
        vertical,
        count:    20,
      },
      { timeout: 30_000 },
    );
    const permutations: Record<string, unknown>[] = permRes.data.permutations ?? [];
    logger.info({ jobId, count: permutations.length }, 'Permutations generated');

    emit(jobId, 'job:update', { status: 'processing', step: 'reasoning', progress: 70 });

    // ── 7. LLM reasoning ─────────────────────────────────────────────────────
    const llmRes = await axios.post(
      `${config.ai.llmReasoning}/reason`,
      { permutations, context: contextData, vertical },
      { timeout: 60_000 },
    );
    const reasonedDesigns: Record<string, unknown>[] = llmRes.data.designs ?? [];
    logger.info({ jobId, count: reasonedDesigns.length }, 'LLM reasoning complete');

    emit(jobId, 'job:update', { status: 'processing', step: 'compositing', progress: 85 });

    // ── 8. Mockup compositor ──────────────────────────────────────────────────
    const mockupRes = await axios.post(
      `${config.ai.mockupCompositor}/compose`,
      { designs: reasonedDesigns, image_keys: imageKeys },
      { timeout: 90_000 },
    );
    const finalDesigns: Record<string, unknown>[] = mockupRes.data.designs ?? [];
    logger.info({ jobId, count: finalDesigns.length }, 'Mockup composition complete');

    // ── 9. Complete ───────────────────────────────────────────────────────────
    const result = {
      designs:     finalDesigns,
      vertical,
      itemCount:   enrichedItems.length,
      designCount: finalDesigns.length,
      generatedAt: new Date().toISOString(),
    };

    await designsService.updateJobStatus(jobId, 'completed', result);
    emit(jobId, 'job:complete', result);

    // Push notification (non-blocking)
    notificationsService.sendPush(
      userId,
      'Your Glimms look is ready ✨',
      `We created ${finalDesigns.length} design${finalDesigns.length !== 1 ? 's' : ''} from your ${vertical}.`,
      { jobId, screen: 'designs' },
    ).catch(() => {});

    logger.info({ jobId, designCount: finalDesigns.length }, '✅ Pipeline completed');

  } catch (err: any) {
    logger.error({ jobId, err: err.message }, '❌ Pipeline failed');
    await designsService.updateJobStatus(jobId, 'failed', undefined, err.message);
    emit(jobId, 'job:failed', { error: 'Design generation failed. Please try again.' });
    throw err;   // re-throw so BullMQ records the failure and retries
  }
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function startDesignWorker(): Worker {
  const worker = new Worker<DesignJobData>('glimms:design-pipeline', runPipeline, {
    connection:  redis,
    concurrency: 5,
    limiter:     { max: 10, duration: 1000 },
  });

  worker.on('completed', job =>
    logger.info({ jobId: job.data.jobId }, 'Worker: job completed'));

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.data?.jobId, err: err.message }, 'Worker: job failed'));

  worker.on('stalled', jobId =>
    logger.warn({ jobId }, 'Worker: job stalled'));

  logger.info('Design pipeline worker started (concurrency: 5)');
  return worker;
}
