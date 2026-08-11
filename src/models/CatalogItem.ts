import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type Vertical = 'wardrobe' | 'room' | 'garden';

export interface IColorInfo {
  dominant: { hex: string; rgb: { r: number; g: number; b: number } };
  palette:  Array<{ hex: string; rgb: { r: number; g: number; b: number } }>;
  mood:     string;
}

export interface ICatalogItem {
  _id:          Types.ObjectId;
  userId:       Types.ObjectId;
  vertical:     Vertical;
  label:        string;
  category:     string;
  color:        IColorInfo;
  texture:      string | null;
  pattern:      string | null;
  imageKey:     string;
  thumbnailKey: string | null;
  confidence:   number;
  attributes:   Record<string, unknown>;
  tags:         string[];
  styleTags:    string[];
  isActive:     boolean;
  createdAt:    Date;
  updatedAt:    Date;
}

export interface ICatalogItemDocument extends ICatalogItem, Document {}

const RgbSchema = new Schema({ r: Number, g: Number, b: Number }, { _id: false });
const ColorSwatchSchema = new Schema({ hex: String, rgb: RgbSchema }, { _id: false });

const ColorInfoSchema = new Schema<IColorInfo>(
  {
    dominant: { type: ColorSwatchSchema, required: true },
    palette:  { type: [ColorSwatchSchema], default: [] },
    mood:     { type: String, default: 'neutral' },
  },
  { _id: false }
);

const CatalogItemSchema = new Schema<ICatalogItemDocument>(
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
    label:    { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    color: {
      type:     ColorInfoSchema,
      required: true,
    },
    texture:      { type: String, default: null },
    pattern:      { type: String, default: null },
    imageKey:     { type: String, required: true },
    thumbnailKey: { type: String, default: null },
    confidence: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    // attributes: flexible object for AI-extracted extras (e.g. sleeve length, material)
    attributes: { type: Schema.Types.Mixed, default: {} },
    tags:       { type: [String], default: [] },
    styleTags:  { type: [String], default: [] },   // CLIP style tags from attribute extractor
    isActive:   { type: Boolean, default: true },
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

// Compound indexes for the most common query patterns
CatalogItemSchema.index({ userId: 1, vertical: 1 });
CatalogItemSchema.index({ userId: 1, isActive: 1 });
CatalogItemSchema.index({ userId: 1, vertical: 1, category: 1 });
CatalogItemSchema.index({ userId: 1, tags: 1 });
CatalogItemSchema.index({ createdAt: -1 });

export const CatalogItem: Model<ICatalogItemDocument> =
  mongoose.model<ICatalogItemDocument>('CatalogItem', CatalogItemSchema);
