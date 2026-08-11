import { Types } from 'mongoose';
import { CatalogItem } from '../models';
import { NotFoundError, ForbiddenError } from '../middleware/errorHandler.middleware';

export const catalogService = {

  async list(userId: string, filters: {
    vertical?: string;
    category?: string;
    tag?:      string;
  }) {
    const query: Record<string, unknown> = { userId, isActive: true };

    if (filters.vertical) query['vertical'] = filters.vertical;
    if (filters.category) query['category'] = new RegExp(filters.category, 'i');
    if (filters.tag)      query['tags']     = filters.tag;

    return CatalogItem
      .find(query)
      .sort({ createdAt: -1 })
      .lean();
  },

  async findOne(id: string, userId: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Catalog item');

    const item = await CatalogItem.findOne({ _id: id, isActive: true });
    if (!item) throw new NotFoundError('Catalog item');
    if (item.userId.toString() !== userId) throw new ForbiddenError('You do not own this item');
    return item;
  },

  async create(userId: string, data: {
    vertical:    string;
    label:       string;
    category:    string;
    color:       Record<string, unknown>;
    imageKey:    string;
    confidence:  number;
    texture?:    string;
    pattern?:    string;
    tags?:       string[];
    styleTags?:  string[];
    attributes?: Record<string, unknown>;
  }) {
    return CatalogItem.create({ userId, ...data });
  },

  async bulkCreate(userId: string, items: Record<string, unknown>[]) {
    const docs = items.map(item => ({ userId, ...item }));
    return CatalogItem.insertMany(docs, { ordered: false });
  },

  async update(id: string, userId: string, data: {
    label?:      string;
    tags?:       string[];
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
