import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface IRefreshToken {
  _id:       Types.ObjectId;
  userId:    Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface IRefreshTokenDocument extends IRefreshToken, Document {}

const RefreshTokenSchema = new Schema<IRefreshTokenDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    tokenHash: {
      type:     String,
      required: true,
      unique:   true,
    },
    expiresAt: {
      type:     Date,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// TTL index — MongoDB auto-deletes expired documents
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshTokenSchema.index({ userId: 1 });

export const RefreshToken: Model<IRefreshTokenDocument> =
  mongoose.model<IRefreshTokenDocument>('RefreshToken', RefreshTokenSchema);
