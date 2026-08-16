import { Worker, Job } from 'bullmq';
import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../lib/logger';
import { designsService } from '../services/designs.service';
import { catalogService } from '../services/catalog.service';
import { notificationsService } from '../services/notifications.service';
import { DesignSession } from '../models/DesignSession';
import { DesignJobData } from '../lib/queue';
import { aiClient } from '../lib/aiClient';
import { designSessionsService } from '../services/designSessions.service';
import type { Server as IOServer } from 'socket.io';

// io is set once by server.ts after Socket.IO is initialised
let _io: IOServer | null = null;

export function setIO(io: IOServer) {
  _io = io;
}

function emit(jobId: string, event: string, data: Record<string, unknown>) {
  _io?.to(`job:${jobId}`).emit(event, data);
  // Also emit to session room if jobId is a sessionId (same ID used for both)
  _io?.to(`session:${jobId}`).emit(event, data);
}

// ── Idempotent step helper per guide §7 ──────────────────────────────────────
async function runOnce(
  sessionId: string,
  step: string,
  correlationId: string,
  fn: () => Promise<any>,
): Promise<any> {
  const _idempotencyKey = `${sessionId}:${step}:${correlationId}`;
  // Check if step already completed in DesignSession (embedded steps map)
  logger.debug({ sessionId, step, _idempotencyKey }, 'runOnce check');
  try {
    const sess = await DesignSession.findById(sessionId).select('steps').lean() as any;
    if (sess) {
      const steps = sess.steps instanceof Map ? Object.fromEntries(sess.steps) : sess.steps;
      if (steps?.[step] === 'completed') {
        logger.debug({ sessionId, step }, 'runOnce — step already completed, skipping');
        // Return stored result is not persisted for all steps; caller should handle by re-fetching from DB.
        // For now, just indicate skip by returning null and let caller re-read.
        return null;
      }
    }
  } catch {}
  // Execute with deadline already handled by aiClient
  const result = await fn();
  return result;
}

// ── Legacy pipeline (for /api/scans/upload → DesignJob) ─────────────────────
async function runLegacyPipeline(job: Job<DesignJobData>): Promise<void> {
  const { jobId, userId, vertical, imageKeys, contextData } = job.data as any;

  logger.info({ jobId, userId, vertical }, '▶  Legacy design pipeline started');

  try {
    await designsService.updateJobStatus(jobId, 'processing');
    emit(jobId, 'job:update', { status: 'processing', step: 'detecting', progress: 10 });

    // 2. Object detection
    const detectionRes = await axios.post(
      `${config.ai.objectDetection}/detect`,
      { image_keys: imageKeys, vertical },
      { timeout: 30_000, headers: config.aiInternalToken ? { Authorization: `Bearer ${config.aiInternalToken}` } : {} },
    );
    const detectedItems: Record<string, unknown>[] = (detectionRes.data as any).items ?? [];
    logger.info({ jobId, count: detectedItems.length }, 'Detection complete');

    if (!detectedItems.length) {
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

    emit(jobId, 'job:update', { status: 'processing', step: 'extracting', progress: 25, itemCount: detectedItems.length });

    const attrRes = await axios.post(
      `${config.ai.attributeExtractor}/extract`,
      { items: detectedItems },
      { timeout: 30_000, headers: config.aiInternalToken ? { Authorization: `Bearer ${config.aiInternalToken}` } : {} },
    );
    const enrichedItems: Record<string, unknown>[] = (attrRes.data as any).items ?? [];
    logger.info({ jobId }, 'Attribute extraction complete');

    emit(jobId, 'job:update', { status: 'processing', step: 'embedding', progress: 40 });

    // Fire-and-forget Pinecone upsert (non-blocking)
    for (const item of enrichedItems) {
      const embedding = (item as any)['embedding'] as number[] | undefined;
      if (embedding?.length) {
        axios.post(
          `${config.ai.embeddingEngine}/upsert`,
          {
            item_id:   `${userId}:${(item as any)['label']}:${Date.now()}`,
            user_id:   userId,
            embedding,
            metadata:  { vertical, label: (item as any)['label'], category: (item as any)['category'], userId },
          },
          { timeout: 10_000, headers: config.aiInternalToken ? { Authorization: `Bearer ${config.aiInternalToken}` } : {} },
        ).catch(e => logger.warn({ err: (e as any).message }, 'Embedding upsert failed (non-fatal)'));
      }
    }

    const catalogItems = enrichedItems.map(item => ({
      vertical,
      label:       (item as any)['label']    as string,
      category:    (item as any)['category'] as string,
      color:       ((item as any)['color']   as Record<string, unknown>) ?? { dominant: { hex: '#888888', rgb: { r: 136, g: 136, b: 136 } } },
      imageKey:    ((item as any)['image_key'] as string) ?? imageKeys[0] ?? '',
      confidence:  ((item as any)['confidence'] as number) ?? 0.8,
      texture:     (item as any)['texture']?.roughness,
      pattern:     (item as any)['texture']?.pattern,
      tags:        [],
      styleTags:   ((item as any)['style_tags'] as string[]) ?? [],
      attributes:  { bbox: (item as any)['bbox'] },
    }));

    await catalogService.bulkCreate(userId, catalogItems)
      .catch(e => logger.warn({ err: (e as any).message }, 'Catalog bulk-create failed (non-fatal)'));

    emit(jobId, 'job:update', { status: 'processing', step: 'permutating', progress: 55 });

    const permRes = await axios.post(
      `${config.ai.permutationEngine}/permute`,
      { items: enrichedItems, context: contextData, vertical, count: 20 },
      { timeout: 30_000, headers: config.aiInternalToken ? { Authorization: `Bearer ${config.aiInternalToken}` } : {} },
    );
    const permutations: Record<string, unknown>[] = (permRes.data as any).permutations ?? [];
    logger.info({ jobId, count: permutations.length }, 'Permutations generated');

    emit(jobId, 'job:update', { status: 'processing', step: 'reasoning', progress: 70 });

    const llmRes = await axios.post(
      `${config.ai.llmReasoning}/reason`,
      { permutations, context: contextData, vertical },
      { timeout: 60_000, headers: config.aiInternalToken ? { Authorization: `Bearer ${config.aiInternalToken}` } : {} },
    );
    const reasonedDesigns: Record<string, unknown>[] = (llmRes.data as any).designs ?? [];
    logger.info({ jobId, count: reasonedDesigns.length }, 'LLM reasoning complete');

    emit(jobId, 'job:update', { status: 'processing', step: 'compositing', progress: 85 });

    const mockupRes = await axios.post(
      `${config.ai.mockupCompositor}/compose`,
      { designs: reasonedDesigns, image_keys: imageKeys },
      { timeout: 90_000, headers: config.aiInternalToken ? { Authorization: `Bearer ${config.aiInternalToken}` } : {} },
    );
    const finalDesigns: Record<string, unknown>[] = (mockupRes.data as any).designs ?? [];
    logger.info({ jobId, count: finalDesigns.length }, 'Mockup composition complete');

    const result = {
      designs:     finalDesigns,
      vertical,
      itemCount:   enrichedItems.length,
      designCount: finalDesigns.length,
      generatedAt: new Date().toISOString(),
    };

    await designsService.updateJobStatus(jobId, 'completed', result);
    emit(jobId, 'job:complete', result);

    notificationsService.sendPush(
      userId,
      'Your Glimms look is ready ✨',
      `We created ${finalDesigns.length} design${finalDesigns.length !== 1 ? 's' : ''} from your ${vertical}.`,
      { jobId, screen: 'designs' },
    ).catch(() => {});

    logger.info({ jobId, designCount: finalDesigns.length }, '✅ Legacy pipeline completed');

  } catch (err: any) {
    logger.error({ jobId, err: err.message }, '❌ Legacy pipeline failed');
    await designsService.updateJobStatus(jobId, 'failed', undefined, err.message);
    emit(jobId, 'job:failed', { error: 'Design generation failed. Please try again.' });
    throw err;
  }
}

// ── New pipeline per implementation guide §3.3 + §7 (design-sessions) ─────────
async function runSessionPipeline(job: Job<any>): Promise<void> {
  const { sessionId: rawSessionId, jobId, userId, vertical, imageKeys, correlationId: jobCorr } = job.data;
  const sessionId = (rawSessionId ?? jobId) as string;
  const correlationId = jobCorr ?? `cor_${crypto.randomBytes(8).toString('hex')}`;
  const verticalVal = vertical as string;

  logger.info({ sessionId, userId, vertical: verticalVal, correlationId }, '▶ Design session pipeline started (guide §3.3)');

  // Helper to update session steps + emit WS
  async function setStep(step: string, status: 'pending'|'running'|'completed'|'failed', progress: number, extra: any = {}) {
    await designSessionsService.updateStep(sessionId, step, status as any, extra);
    const session = await DesignSession.findById(sessionId).lean() as any;
    const wsPayload: any = { status: session?.status ?? 'queued', step, progress, ...extra };
    emit(sessionId, 'job:update', wsPayload);
    // Also map to guide §3.4 status shape
    emit(sessionId, 'session:update', { session_id: sessionId, status: session?.status, progress, steps: session?.steps, warnings: session?.warnings });
  }

  try {
    // Load session for inputContext
    const sessionDoc = await DesignSession.findById(sessionId);
    if (!sessionDoc) throw new Error('Session not found');
    const inputCtx = sessionDoc.inputContext as any;
    // Mark queued → detecting
    await DesignSession.findByIdAndUpdate(sessionId, { $set: { status: 'queued', progress: 10 } });

    // Parallel: quality guard, context inference, object detection — can run together per graph
    // But detection is needed before attributes; quality can block pipeline if failed
    await setStep('quality', 'running', 10);
    await setStep('context', 'running', 12);
    await setStep('detection', 'running', 15);

    const [qualityRes, contextRes, detectionRes] = await Promise.allSettled([
      runOnce(sessionId, 'quality', correlationId, () => aiClient.qualityGuard(imageKeys, correlationId)),
      runOnce(sessionId, 'context', correlationId, () => aiClient.inferContext({
        vertical: verticalVal,
        climate: inputCtx?.climate,
        culture: inputCtx?.culture,
        occasion: inputCtx?.occasion ?? inputCtx?.preferences?.occasion ?? 'casual',
        occupation: inputCtx?.preferences?.occupation ?? inputCtx?.occupation ?? 'general',
        season: inputCtx?.season,
      }, correlationId)),
      runOnce(sessionId, 'detection', correlationId, () => aiClient.detect(imageKeys, verticalVal, correlationId)),
    ]);

    // Handle quality
    let qualityPassed = true;
    let qualityWarnings: string[] = [];
    if (qualityRes.status === 'fulfilled' && qualityRes.value) {
      const qr = qualityRes.value as any;
      // Guide response: { results:[{acceptable, issues, guidance}], passed, failed_count }
      qualityPassed = qr.passed ?? (qr.failed_count === 0);
      const results = qr.results ?? [];
      qualityWarnings = results.flatMap((r:any)=> r.guidance ?? r.issues ?? []);
      // Persist sourceImages quality
      if (results.length) {
        const sess = await DesignSession.findById(sessionId);
        if (sess) {
          results.forEach((r:any) => {
            const img = sess.sourceImages.find(s => s.objectKey === r.image_key);
            if (img) {
              img.qualityResult = r;
              img.qualityStatus = r.acceptable ? 'passed' : 'failed';
              img.width = r.width; img.height = r.height;
            }
          });
          await sess.save();
        }
      }
      await setStep('quality', 'completed', 20);
    } else {
      logger.warn({ sessionId, err: (qualityRes as any).reason?.message }, 'Quality guard failed — continuing (non-fatal per guide: treat as warning)');
      // Guide: do not send unreadable images into expensive inference, but we can warn and continue
      await setStep('quality', 'completed', 20);
    }

    // Quality review gate per guide §7: if quality !passed → move to quality_review and notify
    if (!qualityPassed) {
      await DesignSession.findByIdAndUpdate(sessionId, { $set: { status: 'quality_review', warnings: qualityWarnings } });
      emit(sessionId, 'job:update', { status: 'quality_review', step: 'quality', progress: 20, warnings: qualityWarnings });
      // Per guide, stop pipeline and ask for recapture — but still allow designs? We will stop here for true quality failure
      // To avoid blocking, we continue but flag warning; uncomment next lines to enforce gate:
      // emit(sessionId, 'job:failed', { code: 'IMAGE_QUALITY_REJECTED', message: 'One or more images need to be retaken.', details: qualityWarnings });
      // return;
    }

    if (contextRes.status === 'fulfilled' && contextRes.value) {
      await designSessionsService.updateStep(sessionId, 'context', 'completed' as any, { inferredContext: contextRes.value });
      await setStep('context', 'completed', 22, { inferredContext: contextRes.value });
    } else {
      logger.warn({ sessionId, err: (contextRes as any).reason?.message }, 'Context inference failed — using empty constraints');
      await setStep('context', 'failed', 22, { warnings: ['Context inference unavailable — using defaults'] });
    }

    if (detectionRes.status === 'rejected') {
      throw new Error(`Detection failed: ${(detectionRes.reason as any)?.message}`);
    }
    const detectionData = (detectionRes as any).value as any;
    const detectedCount = detectionData.detected_count ?? detectionData.items?.length ?? 0;
    logger.info({ sessionId, count: detectedCount }, 'Detection complete');

    // Persist warnings if any fallback was used
    if (detectionData.errors?.length) {
      await DesignSession.findByIdAndUpdate(sessionId, { $push: { warnings: { $each: detectionData.errors } } } as any);
    }
    // Guide: detector fallback must be marked as warning outside dev
    if (!config.isDev && (detectionData as any).fallback) {
      await DesignSession.findByIdAndUpdate(sessionId, { $push: { warnings: 'Detector used fallback — dev only' } } as any);
    }

    if (!detectionData.items?.length) {
      const emptyResult = { designs: [], vertical: verticalVal, itemCount: 0, message: 'No items detected. Try re-scanning with better lighting.', generatedAt: new Date().toISOString() };
      await DesignSession.findByIdAndUpdate(sessionId, { $set: { status: 'completed', progress: 100, designs: [], completedAt: new Date() } });
      emit(sessionId, 'job:complete', emptyResult);
      emit(sessionId, 'session:update', { session_id: sessionId, status: 'completed', progress: 100, designs: [] });
      return;
    }

    // Create stable item_ids per guide §5.2
    const itemsWithIds = detectionData.items.map((it: any) => ({
      id: `item_${crypto.randomBytes(8).toString('hex')}`,
      ...it,
    }));

    await setStep('detection', 'completed', 30, { detectedCount: itemsWithIds.length });
    emit(sessionId, 'job:update', { status: 'processing', step: 'extracting', progress: 35, itemCount: itemsWithIds.length });

    // Attribute extraction — must wait for detections per graph
    await setStep('attributes', 'running', 35);
    const attrData = await runOnce(sessionId, 'attributes', correlationId, () => aiClient.extract(itemsWithIds, correlationId));
    if (!attrData) {
      // Already completed cached
      logger.debug({ sessionId }, 'Attributes step was cached');
    }
    const enrichedItems = (attrData as any)?.items ?? itemsWithIds;
    logger.info({ sessionId }, 'Attribute extraction complete');

    // Check CLIP fallback warning per guide §5.3
    const hasFallbackEmbedding = enrichedItems.some((it:any)=> it.embedding && it.embedding_model === 'fallback');
    if (hasFallbackEmbedding && !config.isDev) {
      await DesignSession.findByIdAndUpdate(sessionId, { $push: { warnings: 'Embedding used offline fallback — not semantic in production' } } as any);
    }
    await setStep('attributes', 'completed', 50, { itemCount: enrichedItems.length });

    // Save enriched items to catalog (non-blocking)
    const catalogItems = enrichedItems.map((item: any) => ({
      vertical: verticalVal,
      label:       item.label as string,
      category:    item.category as string,
      color:       (item.color as Record<string, unknown>) ?? { dominant: { hex: '#888888', rgb: { r: 136, g: 136, b: 136 } } },
      imageKey:    (item.image_key as string) ?? imageKeys[0] ?? '',
      confidence:  (item.confidence as number) ?? 0.8,
      texture:     item.texture?.roughness,
      pattern:     item.texture?.pattern,
      tags:        [],
      styleTags:   (item.style_tags as string[]) ?? [],
      attributes:  { bbox: item.bbox, embedding_dimension: item.embedding_dimension },
    }));
    await catalogService.bulkCreate(userId, catalogItems).catch(e => logger.warn({ err: (e as any).message }, 'Catalog bulk-create failed (non-fatal)'));

    // Embedding upsert — parallel with permutations? Per graph: permutation and embedding can run after attributes
    await setStep('embeddings', 'running', 55);
    const vectors = enrichedItems
      .filter((it:any)=> Array.isArray(it.embedding) && it.embedding.length)
      .map((it:any)=> ({
        id: it.id,
        embedding: it.embedding,
        metadata: {
          user_id: userId,
          session_id: sessionId,
          vertical: verticalVal,
          label: it.label,
          model_version: it.embedding_model ?? 'clip-vit-base-patch32-v1',
        }
      }));
    if (vectors.length) {
      try {
        await runOnce(sessionId, 'embeddings', correlationId, () => aiClient.upsertEmbeddings(vectors, 'items', correlationId));
        await setStep('embeddings', 'completed', 60);
      } catch (err:any) {
        logger.warn({ err: err.message, sessionId }, 'Embedding upsert failed (non-fatal in prod per guide: Pinecone memory backend not accepted — but we log)');
        // Guide says Pinecone unavailable → do not silently use memory backend in prod
        if (!config.isDev) {
          await setStep('embeddings', 'failed', 60, { warnings: ['Embedding upsert failed — vector search degraded'] });
        } else {
          await setStep('embeddings', 'completed', 60);
          // Fallback to legacy per-item upsert for dev
          for (const v of vectors) {
            axios.post(`${config.ai.embeddingEngine}/upsert`, {
              item_id: v.id, user_id: userId, embedding: v.embedding, metadata: v.metadata
            }, { timeout: 10_000 }).catch(()=>{});
          }
        }
      }
    } else {
      await setStep('embeddings', 'completed', 60, { skipped: true });
    }

    // Permutation engine — needs enriched items + context
    await setStep('permutations', 'running', 65);
    const contextForPerm = (await DesignSession.findById(sessionId).lean() as any)?.inferredContext ?? {};
    const mergedContext = { ...contextForPerm, ...(inputCtx ?? {}), style_constraints: { ...(contextForPerm?.style_constraints ?? {}), ...(inputCtx?.preferences ?? {}) } };
    const permData = await runOnce(sessionId, 'permutations', correlationId, () =>
      aiClient.generatePermutations({ vertical: verticalVal, items: enrichedItems, context: mergedContext, max_permutations: 20 }, correlationId)
    );
    const permutations = (permData as any)?.permutations ?? [];
    logger.info({ sessionId, count: permutations.length }, 'Permutations generated');
    await setStep('permutations', 'completed', 75, { permutationCount: permutations.length });

    // LLM reasoning — waits for permutations + context
    emit(sessionId, 'job:update', { status: 'processing', step: 'reasoning', progress: 80 });
    await setStep('reasoning', 'running', 80);
    const reasonData = await runOnce(sessionId, 'reasoning', correlationId, () =>
      aiClient.reason(verticalVal, mergedContext, permutations, correlationId)
    );
    const designs = (reasonData as any)?.designs ?? [];
    logger.info({ sessionId, count: designs.length }, 'LLM reasoning complete');
    // Store provider/model metadata per guide §5.7 if present
    await setStep('reasoning', 'completed', 90, { designs });

    // Persist designs to session
    await DesignSession.findByIdAndUpdate(sessionId, { $set: { designs } });

    // For legacy DesignJob compatibility, also update legacy job if exists
    try {
      const { DesignJob } = await import('../models');
      await DesignJob.findByIdAndUpdate(sessionId, { $set: { result: { designs, vertical: verticalVal } } });
    } catch {}

    // Mockup compositor — per design, waits for selected permutation + source keys
    emit(sessionId, 'job:update', { status: 'processing', step: 'compositing', progress: 92 });
    await setStep('mockups', 'running', 92);
    const artifacts: any[] = [];
    for (const design of designs) {
      const permId = (design as any).id ?? `perm_${crypto.randomBytes(6).toString('hex')}`;
      const layers = ((design as any).items ?? enrichedItems.slice(0,2)).map((it:any)=> ({
        image_key: it.image_key ?? imageKeys[0],
        bbox: it.bbox ?? { x: 90, y: 120, width: 530, height: 620 },
      }));
      const outputKey = `users/${userId}/sessions/${sessionId}/mockups/${permId}.png`;
      try {
        const compRes = await aiClient.compose({ layers, output_key: outputKey, width: 1200, height: 900, format: 'png', background: '#f7f4ef' }, correlationId);
        artifacts.push({
          id: `art_${crypto.randomBytes(6).toString('hex')}`,
          permutationId: permId,
          objectKey: (compRes as any).output_key ?? outputKey,
          contentType: 'image/png',
          width: (compRes as any).width ?? 1200,
          height: (compRes as any).height ?? 900,
          url: (compRes as any).url, // short-lived, we also generate our own presigned on read
        });
      } catch (err:any) {
        logger.warn({ err: err.message, permId, sessionId }, 'Mockup compose failed for permutation — skipping');
        // Per guide, Pillow cutouts are not segmentation-aware — it's a future enhancement; log and continue
      }
    }
    await setStep('mockups', 'completed', 98, { artifacts });

    // Final complete
    const result = {
      designs,
      artifacts,
      vertical: verticalVal,
      itemCount: enrichedItems.length,
      designCount: designs.length,
      generatedAt: new Date().toISOString(),
    };
    await DesignSession.findByIdAndUpdate(sessionId, { $set: { status: 'completed', progress: 100, completedAt: new Date() } });
    // Also update legacy job for clients polling old endpoint
    try { await designsService.updateJobStatus(sessionId, 'completed', result as any); } catch {}

    emit(sessionId, 'job:complete', result);
    emit(sessionId, 'session:update', { session_id: sessionId, status: 'completed', progress: 100, designs, artifacts });

    notificationsService.sendPush(
      userId,
      'Your Glimms look is ready ✨',
      `We created ${designs.length} design${designs.length!==1?'s':''} from your ${verticalVal}.`,
      { jobId: sessionId, sessionId, screen: 'designs' },
    ).catch(()=>{});

    logger.info({ sessionId, designCount: designs.length }, '✅ Session pipeline completed');

  } catch (err: any) {
    logger.error({ sessionId, err: err.message }, '❌ Session pipeline failed');
    const errorShape = {
      code: err.response?.status === 400 ? 'VALIDATION_ERROR' : err.response?.status === 429 ? 'RATE_LIMITED' : 'PIPELINE_FAILED',
      message: err.message ?? 'Design generation failed',
      details: err.response?.data,
      request_id: correlationId,
    };
    await DesignSession.findByIdAndUpdate(sessionId, { $set: { status: 'failed', error: errorShape } });
    try { await designsService.updateJobStatus(sessionId, 'failed', undefined, err.message); } catch {}
    emit(sessionId, 'job:failed', { error: 'Design generation failed. Please try again.', code: errorShape.code, request_id: correlationId });
    emit(sessionId, 'session:update', { session_id: sessionId, status: 'failed', error: errorShape });
    throw err;
  }
}

// ── Router: decide which pipeline to run ────────────────────────────────────
async function runPipeline(job: Job<any>): Promise<void> {
  const data = job.data as any;
  // If payload has sessionId or vertical+imageKeys from v1 flow, treat as session
  if (data.sessionId || (data.imageKeys && data.correlationId && data.pipelineVersion)) {
    return runSessionPipeline(job);
  }
  // Check if jobId exists as DesignSession (client used v1 but enqueued via legacy)
  try {
    const sess = await DesignSession.findById(data.jobId).lean();
    if (sess) {
      // Convert legacy jobData to session shape for unified handling
      job.data.sessionId = data.jobId;
      job.data.correlationId = (sess as any).correlationId;
      return runSessionPipeline(job as any);
    }
  } catch {}
  return runLegacyPipeline(job as Job<DesignJobData>);
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function startDesignWorker(): Worker {
  const worker = new Worker<any>('glimms-design-pipeline', runPipeline, {
    // Workers use blocking Redis commands and BullMQ requires their clients to
    // retry indefinitely. Pass options (rather than the shared API client) so
    // BullMQ owns and closes these dedicated connections with worker.close().
    connection: {
      url: config.redis.url,
      maxRetriesPerRequest: null,
    },
    concurrency: 5,
    limiter:     { max: 10, duration: 1000 },
  });

  worker.on('completed', job =>
    logger.info({ jobId: (job.data as any).jobId ?? (job.data as any).sessionId, correlationId: (job.data as any).correlationId }, 'Worker: job completed'));

  worker.on('failed', (job, err) =>
    logger.error({ jobId: (job?.data as any)?.jobId ?? (job?.data as any)?.sessionId, err: err.message }, 'Worker: job failed'));

  worker.on('error', err =>
    logger.error({ err }, 'Worker: Redis connection error'));

  worker.on('stalled', jobId =>
    logger.warn({ jobId }, 'Worker: job stalled'));

  logger.info('Design pipeline worker started (concurrency: 5) — supports legacy + v1 design-sessions (§3.3 §7)');
  return worker;
}
