import { Types } from 'mongoose';
import { DesignJob, SavedDesign } from '../models';
import { enqueueDesignJob, DesignJobData } from '../lib/queue';
import { NotFoundError, ForbiddenError } from '../middleware/errorHandler.middleware';
import { logger } from '../lib/logger';

export const designsService = {

  async createJob(
    userId: string,
    tier: 'free' | 'premium' | 'pro',
    data: {
      vertical:    'wardrobe' | 'room' | 'garden';
      imageKeys:   string[];
      contextData: Record<string, unknown>;
    },
  ) {
    const job = await DesignJob.create({
      userId,
      vertical:    data.vertical,
      imageKeys:   data.imageKeys,
      contextData: data.contextData,
      status:      'pending',
    });

    await enqueueDesignJob({
      jobId:       job._id.toString(),
      userId,
      tier,
      vertical:    data.vertical,
      imageKeys:   data.imageKeys,
      contextData: data.contextData,
    });

    logger.info({ jobId: job._id, userId, vertical: data.vertical }, 'Design job created');

    return {
      jobId:            job._id.toString(),
      status:           'pending',
      estimatedSeconds: data.imageKeys.length * 5,
    };
  },

  async getJob(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Design job');

    const job = await DesignJob.findById(id);
    if (!job) throw new NotFoundError('Design job');
    if (job.userId.toString() !== userId) throw new ForbiddenError();
    return job;
  },

  async listJobs(userId: string, limit = 20) {
    return DesignJob
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('vertical status createdAt completedAt')
      .lean();
  },

  async updateJobStatus(
    jobId: string,
    status: string,
    result?: Record<string, unknown>,
    errorMsg?: string,
  ) {
    const update: Record<string, unknown> = { status };
    if (result)   update['result']      = result;
    if (errorMsg) update['errorMsg']    = errorMsg;
    if (status === 'completed') update['completedAt'] = new Date();

    return DesignJob.findByIdAndUpdate(jobId, { $set: update }, { new: true });
  },

  async getSavedDesigns(userId: string) {
    return SavedDesign
      .find({ userId })
      .sort({ createdAt: -1 })
      .lean();
  },

  async saveDesign(userId: string, jobId: string, data: {
    title?:       string;
    items:        Record<string, unknown>[];
    mockupUrl?:   string;
    explanation?: string;
    tips?:        string[];
    score?:       number;
  }) {
    return SavedDesign.create({ userId, jobId, ...data });
  },

  async toggleFavorite(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Saved design');

    const design = await SavedDesign.findById(id);
    if (!design) throw new NotFoundError('Saved design');
    if (design.userId.toString() !== userId) throw new ForbiddenError();

    return SavedDesign.findByIdAndUpdate(
      id,
      { $set: { isFavorite: !design.isFavorite } },
      { new: true },
    );
  },
};
