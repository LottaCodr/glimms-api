import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type SubStatus = 'active' | 'inactive' | 'past_due' | 'cancelled';

export interface ISubscription {
  _id:                   Types.ObjectId;
  userId:                Types.ObjectId;
  stripeCustomerId:      string | null;
  stripeSubscriptionId:  string | null;
  status:                SubStatus;
  currentPeriodEnd:      Date | null;
  cancelAtPeriodEnd:     boolean;
  createdAt:             Date;
  updatedAt:             Date;
}

export interface ISubscriptionDocument extends ISubscription, Document {}

const SubscriptionSchema = new Schema<ISubscriptionDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      unique:   true,
    },
    stripeCustomerId:     { type: String, default: null, sparse: true },
    stripeSubscriptionId: { type: String, default: null },
    status: {
      type:    String,
      enum:    ['active', 'inactive', 'past_due', 'cancelled'],
      default: 'inactive',
    },
    currentPeriodEnd:  { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  {
    timestamps: true,
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

SubscriptionSchema.index({ userId: 1 },             { unique: true });
SubscriptionSchema.index({ stripeCustomerId: 1 },   { sparse: true });

export const Subscription: Model<ISubscriptionDocument> =
  mongoose.model<ISubscriptionDocument>('Subscription', SubscriptionSchema);
