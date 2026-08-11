import { Types } from 'mongoose';
import { CatalogItem } from '../models';
import { NotFoundError, ForbiddenError } from '../middleware/errorHandler.middleware';
import { getPresignedDownloadUrl } from '../lib/s3';

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const catalogService = {

  async list(
    userId: string,
    filters: {
      vertical?: string;
      category?: string;
      tag?:      string;
    },
    opts: { page: number; limit: number; includeUrls?: boolean } = { page: 1, limit: 20 },
  ) {
    const query: Record<string, unknown> = { userId, isActive: true };

    if (filters.vertical) query['vertical'] = filters.vertical;
    if (filters.category) query['category'] = new RegExp(escapeRegex(filters.category), 'i');
    if (filters.tag)      query['tags']     = filters.tag;

    const { page, limit, includeUrls } = opts;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      CatalogItem.find(query as any).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CatalogItem.countDocuments(query as any),
    ]);

    let enriched = items as any[];
    if (includeUrls) {
      enriched = await Promise.all(items.map(async (it: any) => ({
        ...it,
        imageUrl: it.imageKey ? await getPresignedDownloadUrl(it.imageKey).catch(() => null) : null,
        thumbnailUrl: it.thumbnailKey ? await getPresignedDownloadUrl(it.thumbnailKey).catch(() => null) : null,
      })));
    }

    return {
      items: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  },

  async findOne(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Catalog item');

    const item = await CatalogItem.findOne({ _id: id, isActive: true } as any);
    if (!item) throw new NotFoundError('Catalog item');
    if (item.userId.toString() !== userId) throw new ForbiddenError('You do not own this item');
    return item;
  },

  async getPresignedUrl(id: string, userId: string) {
    const item = await this.findOne(id, userId);
    return getPresignedDownloadUrl(item.imageKey);
  },

  async create(userId: string, data: {
    vertical:    string;
    label:       string;
    category:    string;
    color:       Record<string, unknown>;
    imageKey:    string;
    thumbnailKey?: string;
    confidence:  number;
    texture?:    string;
    pattern?:    string;
    tags?:       string[];
    styleTags?:  string[];
    attributes?: Record<string, unknown>;
  }) {
    return CatalogItem.create({ userId, ...data } as any);
  },

  async bulkCreate(userId: string, items: Record<string, unknown>[]) {
    if (!items.length) return [];
    const docs = items.map(item => ({ userId, ...item }));
    return CatalogItem.insertMany(docs as any, { ordered: false });
  },

  async update(id: string, userId: string, data: {
    label?:      string;
    tags?:       string[];
    styleTags?:  string[];
    attributes?: Record<string, unknown>;
  }) {
    await this.findOne(id, userId);
    return CatalogItem.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true, runValidators: true },
    );
  },

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    await CatalogItem.findByIdAndUpdate(id, { $set: { isActive: false } });
    return { message: 'Item removed from catalog' };
  },
};
