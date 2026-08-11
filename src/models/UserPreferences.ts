import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ILocation {
  lat:     number;
  lon:     number;
  city?:   string;
  country?: string;
}

export interface IUserPreferences {
  _id:         Types.ObjectId;
  userId:      Types.ObjectId;
  occupation:  string | null;
  styleGoals:  string[];
  occasions:   string[];
  culturalCtx: string | null;
  location:    ILocation | null;
  createdAt:   Date;
  updatedAt:   Date;
}

export interface IUserPreferencesDocument extends IUserPreferences, Document {}

const LocationSchema = new Schema<ILocation>(
  {
    lat:     { type: Number, required: true },
    lon:     { type: Number, required: true },
    city:    { type: String },
    country: { type: String },
  },
  { _id: false }
);

const UserPreferencesSchema = new Schema<IUserPreferencesDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      unique:   true,
    },
    occupation:  { type: String, default: null, trim: true },
    styleGoals:  { type: [String], default: [] },
    occasions:   { type: [String], default: [] },
    culturalCtx: { type: String, default: null },
    location:    { type: LocationSchema, default: null },
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

UserPreferencesSchema.index({ userId: 1 }, { unique: true });

export const UserPreferences: Model<IUserPreferencesDocument> =
  mongoose.model<IUserPreferencesDocument>('UserPreferences', UserPreferencesSchema);
