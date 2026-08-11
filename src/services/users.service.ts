import { User, UserPreferences } from '../models';
import { NotFoundError } from '../middleware/errorHandler.middleware';

export const usersService = {

  async findById(id: string) {
    const user = await User.findById(id).select('-passwordHash');
    if (!user) throw new NotFoundError('User');
    return user;
  },

  async update(id: string, data: { name?: string; avatarUrl?: string }) {
    const user = await User.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true, runValidators: true, select: '-passwordHash' },
    );
    if (!user) throw new NotFoundError('User');
    return user;
  },

  async getPreferences(userId: string) {
    return UserPreferences.findOne({ userId });
  },

  async upsertPreferences(userId: string, data: {
    occupation?:  string;
    styleGoals?:  string[];
    occasions?:   string[];
    culturalCtx?: string;
    location?:    { lat: number; lon: number; city?: string; country?: string };
  }) {
    return UserPreferences.findOneAndUpdate(
      { userId },
      { $set: { ...data, userId } },
      { new: true, upsert: true, runValidators: true },
    );
  },

  async deactivate(id: string) {
    await User.findByIdAndUpdate(id, { $set: { isActive: false } });
    return { message: 'Account deactivated' };
  },
};
