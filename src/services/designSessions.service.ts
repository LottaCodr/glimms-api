import crypto from 'crypto';
import { Types } from 'mongoose';
import { DesignSession } from '../models/DesignSession';
import { NotFoundError, ForbiddenError, BadRequestError } from '../middleware/errorHandler.middleware';
import { getPresignedUploadUrl, headObject, verifyObjectOwnership, isAllowedImageType, MAX_IMAGE_BYTES } from '../lib/s3';
import { enqueueDesignJob } from '../lib/queue';
import { logger } from '../lib/logger';
import { config } from '../config';

const PIPELINE_VERSION = '1.0.0';

// Helper to build opaque IDs like ds_01J..., img_01J...
function opaqueId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export const designSessionsService = {

  async createSession(
    userId: string,
    input: {
      vertical: 'wardrobe' | 'room' | 'garden';
      occasion?: string;
      culture?: string;
      climate?: { temperature_c?: number; humidity?: number };
      preferences?: { styles?: string[]; excluded_labels?: string[]; coverage?: string; budget?: unknown };
      imageCount?: number; // how many upload URLs to create (default 1)
    }
  ) {
    const vertical = input.vertical;
    if (!['wardrobe','room','garden'].includes(vertical)) throw new BadRequestError('Invalid vertical');

    const correlationId = `cor_${crypto.randomBytes(8).toString('hex')}`;
    const sessionId = new Types.ObjectId();
    const imageCount = Math.min(Math.max(input.imageCount ?? 1, 1), 5);

    const sourceImages = await Promise.all(
      Array.from({ length: imageCount }).map(async () => {
        const imageId = opaqueId('img');
        const objectKey = `users/${userId}/sessions/${sessionId.toString()}/images/${imageId}/source.png`;
        // Default to png, client can PUT jpeg/png/webp — presigned URL will validate Content-Type if enforced by bucket policy
        // For guide compliance, we issue one per image with 15m expiry
        const { url, expiresAt } = await getPresignedUploadUrl(objectKey, 'image/png', 900).catch(() => {
          // If S3 not configured (local dev without AWS keys), return a fake URL that echoes back
          // so local dev without AWS still works (the complete step will skip HeadObject)
          return { url: `https://fake-s3/${objectKey}?presigned=dev`, expiresAt: new Date(Date.now()+900_000) };
        });
        return { imageId, objectKey, uploadUrl: url, expiresAt, qualityStatus: 'pending' as const };
      })
    );

    const session = await DesignSession.create({
      _id: sessionId,
      userId,
      vertical,
      status: 'created',
      progress: 5,
      steps: { quality:'pending', detection:'pending', attributes:'pending', context:'pending', permutations:'pending', embeddings:'pending', reasoning:'pending', mockups:'pending' },
      inputContext: {
        vertical,
        occasion: input.occasion,
        culture: input.culture,
        climate: input.climate,
        preferences: input.preferences,
      },
      inferredContext: null,
      sourceImages,
      pipelineVersion: PIPELINE_VERSION,
      correlationId,
      warnings: [],
      designs: [],
      artifacts: [],
    });

    logger.info({ sessionId: session._id, userId, vertical, correlationId }, 'Design session created');

    return {
      session_id: session._id.toString(),
      status: session.status,
      upload_urls: sourceImages.map(s => ({
        image_id: s.imageId,
        object_key: s.objectKey,
        upload_url: s.uploadUrl,
        expires_at: s.expiresAt?.toISOString(),
      })),
      correlationId,
    };
  },

  async getSession(sessionId: string, userId: string) {
    if (!Types.ObjectId.isValid(sessionId)) throw new NotFoundError('Design session');
    const session = await DesignSession.findById(sessionId);
    if (!session) throw new NotFoundError('Design session');
    if (session.userId.toString() !== userId) throw new ForbiddenError('You do not own this session');

    // Map to guide §3.4 status model
    const steps = session.steps instanceof Map ? Object.fromEntries(session.steps as any) : (session.steps as any);
    return {
      session_id: session._id.toString(),
      status: session.status,
      vertical: session.vertical,
      progress: session.progress,
      steps,
      designs: session.designs,
      warnings: session.warnings,
      artifacts: session.artifacts,
      sourceImages: session.sourceImages.map(s => ({ image_id: s.imageId, object_key: s.objectKey, qualityStatus: s.qualityStatus, width: s.width, height: s.height })),
      error: session.error ?? null,
      correlationId: session.correlationId,
      createdAt: (session as any).createdAt,
      updatedAt: (session as any).updatedAt,
    };
  },

  async listSessions(userId: string, opts: { page:number; limit:number } = { page:1, limit:20 }) {
    const { page, limit } = opts;
    const skip = (page-1)*limit;
    const [sessions, total] = await Promise.all([
      DesignSession.find({ userId } as any).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DesignSession.countDocuments({ userId } as any),
    ]);
    return {
      sessions: sessions.map(s => ({
        session_id: s._id.toString(),
        status: s.status,
        vertical: s.vertical,
        progress: s.progress,
        createdAt: (s as any).createdAt,
        imageCount: (s.sourceImages as any[])?.length ?? 0,
        designCount: (s.designs as any[])?.length ?? 0,
      })),
      total, page, limit, totalPages: Math.ceil(total/limit),
    };
  },

  // POST /v1/design-sessions/:id/images/complete — verify uploads and enqueue
  async completeImages(sessionId: string, userId: string, imageIds: string[]) {
    if (!Types.ObjectId.isValid(sessionId)) throw new NotFoundError('Design session');
    const session = await DesignSession.findById(sessionId);
    if (!session) throw new NotFoundError('Design session');
    if (session.userId.toString() !== userId) throw new ForbiddenError();
    if (!['created','uploading'].includes(session.status)) {
      throw new BadRequestError(`Session is ${session.status}, cannot complete images`);
    }
    if (!imageIds?.length) throw new BadRequestError('image_ids is required');

    // Validate each imageId belongs to session and verify S3 object exists via HeadObject
    const idSet = new Set(imageIds);
    const matched = session.sourceImages.filter(s => idSet.has(s.imageId));
    if (matched.length !== imageIds.length) {
      throw new BadRequestError('One or more image_ids not found in session');
    }

    const verifiedKeys: string[] = [];
    for (const img of matched) {
      // Ownership check
      if (!(await verifyObjectOwnership(img.objectKey, userId, sessionId))) {
        throw new BadRequestError(`Invalid object_key ownership for ${img.imageId}`);
      }
      // HeadObject verification (best-effort if S3 not configured)
      try {
        const head = await headObject(img.objectKey);
        if (!head.exists) {
          // In dev without S3, allow missing — log warning
          if (config.isDev) {
            logger.warn({ objectKey: img.objectKey }, 'HeadObject not found — dev mode, allowing');
            verifiedKeys.push(img.objectKey);
          } else {
            throw new BadRequestError(`Image not uploaded yet: ${img.imageId} (${img.objectKey})`);
          }
        } else {
          // Validate MIME and size per guide §3.2
          if (head.contentType && !isAllowedImageType(head.contentType)) {
            throw new BadRequestError(`Invalid MIME type for ${img.imageId}: ${head.contentType}`);
          }
          if (head.contentLength && head.contentLength > MAX_IMAGE_BYTES) {
            throw new BadRequestError(`Image too large for ${img.imageId}: ${head.contentLength} bytes > 15MB`);
          }
          // Update metadata
          img.contentType = head.contentType;
          img.byteSize = head.contentLength ?? undefined;
          verifiedKeys.push(img.objectKey);
        }
      } catch (err: any) {
        if (err instanceof BadRequestError) throw err;
        logger.warn({ err: err.message, objectKey: img.objectKey }, 'HeadObject verification error — allowing in dev');
        if (config.isDev) verifiedKeys.push(img.objectKey);
        else throw new BadRequestError(`Failed to verify image ${img.imageId}`);
      }
    }

    // Persist verified metadata and move to queued
    await DesignSession.findByIdAndUpdate(sessionId, {
      $set: {
        status: 'queued',
        progress: 10,
        sourceImages: session.sourceImages,
      }
    });

    // Enqueue design.analysis.requested — reuse existing queue but with sessionId
    // For guide compliance, we use a distinct queue name via same BullMQ with pipelineVersion
    const jobData = {
      jobId: sessionId, // for WS room compatibility, use sessionId as jobId
      sessionId,
      userId,
      tier: 'free' as const, // tier will be looked up by worker from User
      vertical: session.vertical,
      imageKeys: verifiedKeys,
      contextData: session.inputContext,
      correlationId: session.correlationId,
      pipelineVersion: PIPELINE_VERSION,
    };

    // Lookup tier from User for priority
    try {
      const { User } = await import('../models');
      const user = await User.findById(userId).select('tier');
      if (user) (jobData as any).tier = user.tier;
    } catch {}

    await enqueueDesignJob(jobData as any);

    logger.info({ sessionId, userId, verifiedKeys: verifiedKeys.length, correlationId: session.correlationId }, 'Session images completed — enqueued');

    return {
      session_id: sessionId,
      status: 'queued',
      image_count: verifiedKeys.length,
      message: 'Uploads verified — analysis queued',
    };
  },

  async cancelSession(sessionId: string, userId: string) {
    await this.getSession(sessionId, userId); // verify ownership
    await DesignSession.findByIdAndUpdate(sessionId, { $set: { status: 'cancelled', progress: 0 } });
    return { session_id: sessionId, status: 'cancelled' };
  },

  // Internal: update step status + progress (called by worker)
  async updateStep(sessionId: string, step: string, status: 'pending'|'running'|'completed'|'failed'|'skipped', extra: any = {}) {
    const session = await DesignSession.findById(sessionId);
    if (!session) return;
    const steps = session.steps instanceof Map ? Object.fromEntries(session.steps as any) : { ...(session.steps as any) };
    steps[step] = status;
    const progressMap: Record<string, number> = {
      quality: 10, detection: 25, attributes: 40, context: 45, permutations: 55, embeddings: 60, reasoning: 75, mockups: 90, completed: 100
    };
    let progress = session.progress;
    if (status === 'completed' && progressMap[step]) progress = Math.max(progress, progressMap[step]);
    if (status === 'running' && progressMap[step]) progress = Math.max(progress, progressMap[step]-5);

    const update: any = { steps, progress };
    if (extra.inferredContext) update.inferredContext = extra.inferredContext;
    if (extra.warnings) update.warnings = extra.warnings;
    if (extra.designs) update.designs = extra.designs;
    if (extra.artifacts) update.artifacts = extra.artifacts;
    if (extra.error) { update.error = extra.error; update.status = 'failed'; }
    if (step === 'mockups' && status === 'completed') { update.status = 'completed'; update.completedAt = new Date(); update.progress = 100; }
    else if (status === 'running') {
      // Map step to session status for polling UI per guide §3.4
      const statusMap: Record<string, string> = {
        quality: 'quality_review', detection: 'detecting', attributes: 'extracting',
        context: 'detecting', permutations: 'permuting', embeddings: 'embedding',
        reasoning: 'reasoning', mockups: 'composing'
      };
      if (statusMap[step]) update.status = statusMap[step];
    }
    await DesignSession.findByIdAndUpdate(sessionId, { $set: update });
    return update;
  },
};
