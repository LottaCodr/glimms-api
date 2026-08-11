import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { Vertical } from './CatalogItem';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IDesignJob {
  _id:         Types.ObjectId;
  userId:      Types.ObjectId;
  vertical:    Vertical;
  status:      JobStatus;
  imageKeys:   string[];
  contextData: Record<string, unknown>;
  result:      Record<string, unknown> | null;
  errorMsg:    string | null;
  completedAt: Date | null;
  createdAt:   Date;
  updatedAt:   Date;
}

export interface IDesignJobDocument extends IDesignJob, Document {}

const DesignJobSchema = new Schema<IDesignJobDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    vertical: {
      type:     String,
      enum:     ['wardrobe', 'room', 'garden'],
      required: true,
    },
    status: {
      type:    String,
      enum:    ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    imageKeys:   { type: [String], default: [] },
    contextData: { type: Schema.Types.Mixed, default: {} },
    result:      { type: Schema.Types.Mixed, default: null },
    errorMsg:    { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; return ret; },
    },
  }
);

DesignJobSchema.index({ userId: 1, status: 1 });
DesignJobSchema.index({ userId: 1, createdAt: -1 });

export const DesignJob: Model<IDesignJobDocument> =
  mongoose.model<IDesignJobDocument>('DesignJob', DesignJobSchema);
