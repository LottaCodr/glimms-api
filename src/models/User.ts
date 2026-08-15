import mongoose, { Schema, Document, Model, Types } from 'mongoose';

// ── TypeScript interfaces ──────────────────────────────────────────────────────

export interface IUser {
  _id:          Types.ObjectId;
  email:        string;
  passwordHash: string | null;
  name:         string | null;
  avatarUrl:    string | null;
  tier:         'free' | 'premium' | 'pro';
  isActive:     boolean;
  createdAt:    Date;
  updatedAt:    Date;
}

export interface IUserDocument extends IUser, Document {
  _id: Types.ObjectId;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const UserSchema = new Schema<IUserDocument>(
  {
    // NOTE: unique index is declared once below via UserSchema.index()
    email: {
      type:     String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim:     true,
      match:    [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    passwordHash: {
      type:    String,
      default: null,
      select:  false,   // never returned in queries by default — must explicitly .select('+passwordHash')
    },
    name: {
      type:    String,
      default: null,
      trim:    true,
      maxlength: [100, 'Name too long'],
    },
    avatarUrl: {
      type:    String,
      default: null,
    },
    tier: {
      type:     String,
      enum:     ['free', 'premium', 'pro'],
      default:  'free',
    },
    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps: true,   // adds createdAt and updatedAt automatically
    versionKey: false,  // removes __v field
    toJSON: {
      virtuals: true,
      transform: (_doc: any, ret: any) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.passwordHash;   // never leak password hash in JSON
        // Mongoose adds __v even when versionKey false in some edge cases
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: (_doc: any, ret: any) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ tier: 1 });
UserSchema.index({ createdAt: -1 });

// ── Model ─────────────────────────────────────────────────────────────────────

export const User: Model<IUserDocument> = mongoose.model<IUserDocument>('User', UserSchema);
