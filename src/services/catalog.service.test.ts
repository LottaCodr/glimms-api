import mongoose from 'mongoose';
import { catalogService } from '../services/catalog.service';
import { CatalogItem } from '../models/CatalogItem';

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/glimms_test';
const MOCK_USER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_USER_ID = new mongoose.Types.ObjectId().toString();

const MOCK_ITEM = {
  vertical:   'wardrobe' as const,
  label:      'white shirt',
  category:   'top',
  color:      { dominant: { hex: '#ffffff', rgb: { r: 255, g: 255, b: 255 } }, palette: [], mood: 'neutral' },
  imageKey:   'uploads/test/shirt.jpg',
  confidence: 0.92,
  tags:       ['cotton', 'classic'],
  styleTags:  ['smart-casual'],
};

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await CatalogItem.deleteMany({});
});

describe('catalogService.create', () => {
  it('creates an item and returns it', async () => {
    const item = await catalogService.create(MOCK_USER_ID, MOCK_ITEM);
    expect(item.label).toBe('white shirt');
    expect(item.userId.toString()).toBe(MOCK_USER_ID);
    expect(item.isActive).toBe(true);
  });
});

describe('catalogService.list', () => {
  beforeEach(async () => {
    await catalogService.create(MOCK_USER_ID, MOCK_ITEM);
    await catalogService.create(MOCK_USER_ID, { ...MOCK_ITEM, vertical: 'room', label: 'sofa', category: 'seating' });
    await catalogService.create(OTHER_USER_ID, MOCK_ITEM);
  });

  it('returns only the requesting user\'s items', async () => {
    const items = await catalogService.list(MOCK_USER_ID, {});
    expect(items.length).toBe(2);
    items.forEach(i => expect(i.userId.toString()).toBe(MOCK_USER_ID));
  });

  it('filters by vertical', async () => {
    const items = await catalogService.list(MOCK_USER_ID, { vertical: 'room' });
    expect(items.length).toBe(1);
    expect(items[0].label).toBe('sofa');
  });

  it('filters by tag', async () => {
    const items = await catalogService.list(MOCK_USER_ID, { tag: 'cotton' });
    expect(items.length).toBe(1);
  });

  it('returns empty array for unknown vertical', async () => {
    const items = await catalogService.list(MOCK_USER_ID, { vertical: 'garden' });
    expect(items).toEqual([]);
  });
});

describe('catalogService.findOne', () => {
  it('returns the item for the owner', async () => {
    const created = await catalogService.create(MOCK_USER_ID, MOCK_ITEM);
    const found = await catalogService.findOne(created._id.toString(), MOCK_USER_ID);
    expect(found.label).toBe('white shirt');
  });

  it('throws ForbiddenError for wrong owner', async () => {
    const created = await catalogService.create(MOCK_USER_ID, MOCK_ITEM);
    await expect(
      catalogService.findOne(created._id.toString(), OTHER_USER_ID),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws NotFoundError for invalid id', async () => {
    await expect(
      catalogService.findOne('not-an-object-id', MOCK_USER_ID),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('catalogService.update', () => {
  it('updates label and tags', async () => {
    const created = await catalogService.create(MOCK_USER_ID, MOCK_ITEM);
    const updated = await catalogService.update(
      created._id.toString(), MOCK_USER_ID,
      { label: 'blue shirt', tags: ['linen'] },
    );
    expect(updated!.label).toBe('blue shirt');
    expect(updated!.tags).toContain('linen');
  });
});

describe('catalogService.remove', () => {
  it('soft-deletes the item', async () => {
    const created = await catalogService.create(MOCK_USER_ID, MOCK_ITEM);
    await catalogService.remove(created._id.toString(), MOCK_USER_ID);

    const items = await catalogService.list(MOCK_USER_ID, {});
    expect(items.length).toBe(0);
  });
});

describe('catalogService.bulkCreate', () => {
  it('creates multiple items at once', async () => {
    const items = [MOCK_ITEM, { ...MOCK_ITEM, label: 'jeans', category: 'bottom' }];
    const result = await catalogService.bulkCreate(MOCK_USER_ID, items);
    expect(result.length).toBe(2);
  });
});
