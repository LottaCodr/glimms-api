import Stripe from 'stripe';
import { Subscription, User } from '../models';
import { config } from '../config';
import { logger } from '../lib/logger';
import { NotFoundError } from '../middleware/errorHandler.middleware';

const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2023-10-16' })
  : null;

export const subscriptionsService = {

  async getByUserId(userId: string) {
    const sub = await Subscription.findOne({ userId });
    if (!sub) throw new NotFoundError('Subscription');
    return sub;
  },

  async createCheckoutSession(userId: string, priceId: string) {
    if (!stripe) throw new Error('Stripe is not configured');

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    // Get or create Stripe customer
    let sub = await Subscription.findOne({ userId });
    let customerId = sub?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    user.email,
        metadata: { userId },
      });
      customerId = customer.id;

      sub = await Subscription.findOneAndUpdate(
        { userId },
        { $set: { userId, stripeCustomerId: customerId } },
        { new: true, upsert: true },
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer:    customerId,
      mode:        'subscription',
      line_items:  [{ price: priceId, quantity: 1 }],
      success_url: 'https://app.glimms.ai/dashboard?upgrade=success',
      cancel_url:  'https://app.glimms.ai/upgrade?cancelled=true',
    });

    return { url: session.url };
  },

  async handleWebhook(rawBody: Buffer, signature: string) {
    if (!stripe || !config.stripe.webhookSecret) return { received: false };

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    } catch {
      logger.error('Stripe webhook signature verification failed');
      return { received: false };
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const s     = event.data.object as Stripe.Subscription;
        const tier  = ((s as any).metadata?.tier ?? 'premium').toLowerCase();

        await Subscription.findOneAndUpdate(
          { stripeCustomerId: s.customer as string },
          {
            $set: {
              stripeSubscriptionId: s.id,
              status:               s.status === 'active' ? 'active' : 'inactive',
              currentPeriodEnd:     new Date((s as any).current_period_end * 1000),
              cancelAtPeriodEnd:    s.cancel_at_period_end,
            },
          },
        );

        // Upgrade the user's tier
        const subscription = await Subscription.findOne({ stripeCustomerId: s.customer as string });
        if (subscription) {
          await User.findByIdAndUpdate(subscription.userId, { $set: { tier } });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const s = event.data.object as Stripe.Subscription;
        await Subscription.findOneAndUpdate(
          { stripeCustomerId: s.customer as string },
          { $set: { status: 'cancelled', stripeSubscriptionId: null } },
        );
        const subscription = await Subscription.findOne({ stripeCustomerId: s.customer as string });
        if (subscription) {
          await User.findByIdAndUpdate(subscription.userId, { $set: { tier: 'free' } });
        }
        break;
      }
    }

    return { received: true };
  },
};
