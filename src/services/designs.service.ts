import { Types } from 'mongoose';
import { DesignJob, SavedDesign } from '../models';
import { enqueueDesignJob } from '../lib/queue';
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

  async listJobs(userId: string, opts: { page: number; limit: number } = { page: 1, limit: 20 }) {
    const { page, limit } = opts;
    const skip = (page - 1) * limit;
    const [jobs, total] = await Promise.all([
      DesignJob.find({ userId } as any).sort({ createdAt: -1 }).skip(skip).limit(limit).select('vertical status createdAt completedAt').lean(),
      DesignJob.countDocuments({ userId } as any),
    ]);
    return { jobs, total, page, limit, totalPages: Math.ceil(total / limit) };
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

  async getSavedDesigns(userId: string, opts: { page: number; limit: number; favorite?: boolean } = { page: 1, limit: 20 }) {
    const { page, limit, favorite } = opts;
    const query: any = { userId };
    if (favorite !== undefined) query.isFavorite = favorite;
    const skip = (page - 1) * limit;
    const [designs, total] = await Promise.all([
      SavedDesign.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SavedDesign.countDocuments(query),
    ]);
    return { designs, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  async saveDesign(userId: string, jobId: string, data: {
    title?:       string;
    items:        Record<string, unknown>[];
    mockupUrl?:   string;
    explanation?: string;
    tips?:        string[];
    score?:       number;
  }) {
    if (!Types.ObjectId.isValid(jobId)) throw new NotFoundError('Design job');
    const job = await DesignJob.findById(jobId);
    if (!job) throw new NotFoundError('Design job');
    if (job.userId.toString() !== userId) throw new ForbiddenError('You do not own this job');
    return SavedDesign.create({ userId, jobId, ...data } as any);
  },

  async deleteSavedDesign(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Saved design');
    const design = await SavedDesign.findById(id);
    if (!design) throw new NotFoundError('Saved design');
    if (design.userId.toString() !== userId) throw new ForbiddenError();
    await SavedDesign.deleteOne({ _id: id });
    return { message: 'Saved design deleted' };
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
