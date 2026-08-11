import mongoose, { Schema, Document, Model, Types } from 'mongoose';

// ── SavedDesign ───────────────────────────────────────────────────────────────

export interface ISavedDesign {
  _id:         Types.ObjectId;
  userId:      Types.ObjectId;
  jobId:       Types.ObjectId;
  title:       string | null;
  items:       Record<string, unknown>[];
  mockupUrl:   string | null;
  explanation: string | null;
  tips:        string[];
  score:       number;
  isFavorite:  boolean;
  tags:        string[];
  createdAt:   Date;
}

export interface ISavedDesignDocument extends ISavedDesign, Document {}

const SavedDesignSchema = new Schema<ISavedDesignDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    jobId: {
      type:     Schema.Types.ObjectId,
      ref:      'DesignJob',
      required: true,
    },
    title:       { type: String, default: null, trim: true },
    items:       { type: Schema.Types.Mixed, default: [] } as any,
    mockupUrl:   { type: String, default: null },
    explanation: { type: String, default: null },
    tips:        { type: [String], default: [] },
    score:       { type: Number, default: 0, min: 0, max: 1 },
    isFavorite:  { type: Boolean, default: false },
    tags:        { type: [String], default: [] },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (_doc: any, ret: any) => { ret.id = ret._id; delete ret._id; delete ret.__v; return ret; },
    },
    toObject: {
      virtuals: true,
      transform: (_doc: any, ret: any) => { ret.id = ret._id; delete ret._id; return ret; },
    },
  }
);

SavedDesignSchema.index({ userId: 1 });
SavedDesignSchema.index({ userId: 1, isFavorite: 1 });
SavedDesignSchema.index({ userId: 1, createdAt: -1 });

export const SavedDesign: Model<ISavedDesignDocument> =
  mongoose.model<ISavedDesignDocument>('SavedDesign', SavedDesignSchema);


// ── DeviceToken ───────────────────────────────────────────────────────────────

export interface IDeviceToken {
  _id:       Types.ObjectId;
  userId:    Types.ObjectId;
  token:     string;
  platform:  'ios' | 'android';
  createdAt: Date;
}

export interface IDeviceTokenDocument extends IDeviceToken, Document {}

const DeviceTokenSchema = new Schema<IDeviceTokenDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    token: {
      type:     String,
      required: true,
      unique:   true,
    },
    platform: {
      type:     String,
      enum:     ['ios', 'android'],
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

DeviceTokenSchema.index({ userId: 1 });
// NOTE: the unique index on `token` is declared inline on the field.

export const DeviceToken: Model<IDeviceTokenDocument> =
  mongoose.model<IDeviceTokenDocument>('DeviceToken', DeviceTokenSchema);
