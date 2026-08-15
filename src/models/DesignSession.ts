import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { Vertical } from './CatalogItem';

export type SessionStatus =
  | 'created'       // after POST /v1/design-sessions
  | 'uploading'     // presigned URLs issued, awaiting client upload
  | 'queued'        // images confirmed, job enqueued
  | 'quality_review'// quality guard failed, needs retake
  | 'detecting' | 'extracting' | 'permuting' | 'embedding' | 'reasoning' | 'composing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface ISourceImage {
  imageId: string;          // img_01J...
  objectKey: string;        // users/<userId>/sessions/<sessionId>/images/<imageId>/source.png
  uploadUrl?: string;       // presigned PUT (only at creation time, not persisted long)
  expiresAt?: Date;
  contentType?: string;
  byteSize?: number;
  width?: number; height?: number;
  sha256?: string;
  qualityResult?: Record<string, unknown> | null;
  qualityStatus?: 'pending' | 'passed' | 'failed' | 'error';
}

export interface IDesignSession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  vertical: Vertical;
  status: SessionStatus;
  progress: number; // 0-100
  steps: Record<'quality'|'detection'|'attributes'|'context'|'permutations'|'embeddings'|'reasoning'|'mockups', StepStatus>;
  inputContext: Record<string, unknown>;     // original explicit user inputs (occasion, culture, climate, preferences, coverage, budget)
  inferredContext: Record<string, unknown> | null; // output of context inference service
  sourceImages: ISourceImage[];
  pipelineVersion: string;
  correlationId: string;
  warnings: string[];
  designs: Record<string, unknown>[]; // final LLM designs + mockup artifact keys
  artifacts: Array<{ id: string; permutationId: string; objectKey: string; contentType: string; sha256?: string; width?: number; height?: number; url?: string }>;
  error?: { code: string; message: string; details?: unknown } | null;
  createdAt: Date; updatedAt: Date; completedAt: Date | null;
}

export interface IDesignSessionDocument extends IDesignSession, Document { _id: Types.ObjectId }

const SourceImageSchema = new Schema<ISourceImage>({
  imageId: { type: String, required: true },
  objectKey: { type: String, required: true },
  uploadUrl: { type: String },
  expiresAt: { type: Date },
  contentType: { type: String },
  byteSize: { type: Number },
  width: { type: Number }, height: { type: Number },
  sha256: { type: String },
  qualityResult: { type: Schema.Types.Mixed, default: null },
  qualityStatus: { type: String, enum: ['pending','passed','failed','error'], default: 'pending' },
}, { _id: false });

const DesignSessionSchema = new Schema<IDesignSessionDocument>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  vertical: { type: String, enum: ['wardrobe','room','garden'], required: true },
  status: {
    type: String,
    enum: ['created','uploading','queued','quality_review','detecting','extracting','permuting','embedding','reasoning','composing','completed','failed','cancelled'],
    default: 'created',
  },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  steps: {
    type: Map,
    of: { type: String, enum: ['pending','running','completed','failed','skipped'] },
    default: () => ({
      quality: 'pending', detection: 'pending', attributes: 'pending',
      context: 'pending', permutations: 'pending', embeddings: 'pending',
      reasoning: 'pending', mockups: 'pending',
    }),
  },
  inputContext: { type: Schema.Types.Mixed, default: {} },
  inferredContext: { type: Schema.Types.Mixed, default: null },
  sourceImages: { type: [SourceImageSchema], default: [] },
  pipelineVersion: { type: String, default: '1.0.0' },
  correlationId: { type: String, required: true },
  warnings: { type: [String], default: [] },
  designs: { type: Schema.Types.Mixed, default: [] } as any,
  artifacts: { type: Schema.Types.Mixed, default: [] } as any,
  error: { type: Schema.Types.Mixed, default: null },
  completedAt: { type: Date, default: null },
}, {
  timestamps: true,
  versionKey: false,
  toJSON: {
    virtuals: true,
    transform: (_doc: any, ret: any) => { ret.id = ret._id; delete ret._id; delete ret.__v; if (ret.steps instanceof Map) ret.steps = Object.fromEntries(ret.steps); return ret; }
  },
  toObject: {
    virtuals: true,
    transform: (_doc: any, ret: any) => { ret.id = ret._id; delete ret._id; if (ret.steps instanceof Map) ret.steps = Object.fromEntries(ret.steps); return ret; }
  }
});

DesignSessionSchema.index({ userId: 1, status: 1 });
DesignSessionSchema.index({ userId: 1, createdAt: -1 });
DesignSessionSchema.index({ correlationId: 1 });

export const DesignSession: Model<IDesignSessionDocument> =
  mongoose.models.DesignSession ?? mongoose.model<IDesignSessionDocument>('DesignSession', DesignSessionSchema);

// ── PipelineJob for idempotency (section 6 pipeline_jobs) ───────────────────
export interface IPipelineJob {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  step: string;
  idempotencyKey: string;
  status: 'pending'|'running'|'completed'|'failed';
  attempts: number;
  lastError?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  nextRetryAt?: Date | null;
  correlationId: string;
  createdAt: Date; updatedAt: Date;
}

const PipelineJobSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, ref: 'DesignSession', required: true },
  step: { type: String, required: true },
  // NOTE: unique index is declared once below via PipelineJobSchema.index()
  idempotencyKey: { type: String, required: true },
  status: { type: String, enum: ['pending','running','completed','failed'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  nextRetryAt: { type: Date, default: null },
  correlationId: { type: String, required: true },
}, { timestamps: true, versionKey: false });

PipelineJobSchema.index({ sessionId: 1, step: 1 }, { unique: true });
PipelineJobSchema.index({ idempotencyKey: 1 }, { unique: true });
PipelineJobSchema.index({ correlationId: 1 });

export const PipelineJob = mongoose.models.PipelineJob ?? mongoose.model('PipelineJob', PipelineJobSchema);
