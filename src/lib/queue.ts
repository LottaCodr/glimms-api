import { Queue } from 'bullmq';
import { redis } from './redis';
import { logger } from './logger';

export const designQueue = new Queue('glimms:design-pipeline', {
  // BullMQ ships its own ioredis copy — cast to avoid duplicate-type conflicts
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 100 },
  },
});

export const notificationQueue = new Queue('glimms:notifications', {
  connection: redis as any,
  defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 2000 } },
});

export interface DesignJobData {
  jobId:       string;
  userId:      string;
  vertical:    'wardrobe' | 'room' | 'garden';
  imageKeys:   string[];
  contextData: Record<string, unknown>;
  tier:        'free' | 'premium' | 'pro';
  // v1 design-sessions (per implementation guide)
  sessionId?: string;
  correlationId?: string;
  pipelineVersion?: string;
}

export interface NotificationJobData {
  type:       'push' | 'email';
  userId:     string;
  title?:     string;
  body?:      string;
  templateId?: string;
  data?:      Record<string, unknown>;
}

export async function enqueueDesignJob(data: DesignJobData) {
  const priority = data.tier === 'pro' ? 1 : data.tier === 'premium' ? 5 : 10;
  const job = await designQueue.add('run', data, { priority });
  logger.info({ jobId: data.jobId ?? (data as any).sessionId, priority, correlationId: (data as any).correlationId }, 'Design job enqueued');
  return job;
}

export async function enqueueNotification(data: NotificationJobData) {
  return notificationQueue.add('send', data);
}
