import { DeviceToken } from '../models';
import { config } from '../config';
import { logger } from '../lib/logger';
import * as admin from 'firebase-admin';
import sgMail from '@sendgrid/mail';

// ── Firebase Admin init (once) ────────────────────────────────────────────────

if (config.firebase.projectId && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey:  config.firebase.privateKey,
    } as admin.ServiceAccount),
  });
  logger.info('Firebase Admin initialised');
}

// ── SendGrid init (once) ──────────────────────────────────────────────────────

if (config.sendgrid.apiKey) {
  sgMail.setApiKey(config.sendgrid.apiKey);
}

// ── Service ───────────────────────────────────────────────────────────────────

export const notificationsService = {

  async registerDevice(userId: string, token: string, platform: 'ios' | 'android') {
    return DeviceToken.findOneAndUpdate(
      { token },
      { $set: { userId, token, platform } },
      { new: true, upsert: true },
    );
  },

  async sendPush(
    userId:  string,
    title:   string,
    body:    string,
    data?:   Record<string, string>,
  ) {
    if (!admin.apps.length) {
      logger.warn('Firebase not configured — push notification skipped');
      return { sent: 0 };
    }

    const deviceTokens = await DeviceToken.find({ userId }).lean();
    if (!deviceTokens.length) return { sent: 0 };

    const results = await Promise.allSettled(
      deviceTokens.map(({ token }) =>
        admin.messaging().send({
          token,
          notification: { title, body },
          data:         data ?? {},
          apns: {
            payload: { aps: { sound: 'default', badge: 1 } },
          },
          android: { priority: 'high' },
        })
      ),
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    logger.info({ userId, sent, failed }, 'Push notifications dispatched');
    return { sent };
  },

  async sendEmail(to: string, subject: string, html: string) {
    if (!config.sendgrid.apiKey) {
      logger.warn('SendGrid not configured — email skipped');
      return;
    }
    await sgMail.send({ to, from: config.sendgrid.fromEmail, subject, html });
    logger.info({ to }, 'Email sent');
  },
};
