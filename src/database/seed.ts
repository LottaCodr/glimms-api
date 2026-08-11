/**
 * Seed script — populates MongoDB with dev data.
 * Run: npm run seed
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { UserPreferences } from '../models/UserPreferences';
import { CatalogItem } from '../models/CatalogItem';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/glimms';

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Clear existing data
  await Promise.all([
    User.deleteMany({}),
    UserPreferences.deleteMany({}),
    CatalogItem.deleteMany({}),
  ]);

  // Create dev users
  const passwordHash = await bcrypt.hash('password123', 10);

  const [freeUser, premiumUser] = await User.insertMany([
    {
      email:        'free@glimms.ai',
      passwordHash,
      name:         'Free User',
      tier:         'free',
    },
    {
      email:        'premium@glimms.ai',
      passwordHash,
      name:         'Premium User',
      tier:         'premium',
    },
  ]);

  console.log(`✅ Created users: ${freeUser.email}, ${premiumUser.email}`);

  // Preferences
  await UserPreferences.create({
    userId:      freeUser._id,
    occupation:  'designer',
    styleGoals:  ['look professional', 'be comfortable'],
    occasions:   ['work', 'casual'],
    culturalCtx: 'west_africa',
    location:    { lat: 6.5, lon: 3.3, city: 'Lagos', country: 'Nigeria' },
  });

  // Sample catalog items
  await CatalogItem.insertMany([
    {
      userId:     freeUser._id,
      vertical:   'wardrobe',
      label:      'white button shirt',
      category:   'top',
      color:      { dominant: { hex: '#f5f5f5', rgb: { r: 245, g: 245, b: 245 } }, palette: [], mood: 'neutral' },
      imageKey:   'uploads/seed/shirt.jpg',
      confidence: 0.95,
      tags:       ['cotton', 'formal'],
      styleTags:  ['smart-casual', 'formal'],
    },
    {
      userId:     freeUser._id,
      vertical:   'wardrobe',
      label:      'navy chinos',
      category:   'bottom',
      color:      { dominant: { hex: '#1e3a5f', rgb: { r: 30, g: 58, b: 95 } }, palette: [], mood: 'cool' },
      imageKey:   'uploads/seed/chinos.jpg',
      confidence: 0.91,
      tags:       ['cotton', 'slim-fit'],
      styleTags:  ['smart-casual', 'formal'],
    },
    {
      userId:     freeUser._id,
      vertical:   'wardrobe',
      label:      'white sneakers',
      category:   'footwear',
      color:      { dominant: { hex: '#ffffff', rgb: { r: 255, g: 255, b: 255 } }, palette: [], mood: 'neutral' },
      imageKey:   'uploads/seed/sneakers.jpg',
      confidence: 0.88,
      tags:       ['casual'],
      styleTags:  ['casual', 'minimalist'],
    },
  ]);

  console.log('✅ Created sample catalog items');
  console.log('\n📋 Dev credentials:');
  console.log('  free@glimms.ai     / password123  (free tier)');
  console.log('  premium@glimms.ai  / password123  (premium tier)');

  await mongoose.disconnect();
  console.log('\n✅ Seed complete');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
