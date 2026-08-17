import sharp from 'sharp';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { uploadToS3 } from '../lib/s3';
import { aiClient } from '../lib/aiClient';
import { logger } from '../lib/logger';

export const scansService = {

  async processUpload(
    files:       Express.Multer.File[],
    userId:      string,
    vertical:    string,
    contextData: Record<string, unknown>,
  ): Promise<{ uploadedKeys: string[]; qualityWarning: string | null }> {

    const correlationId = randomUUID();
    const uploadedKeys: string[] = [];

    logger.info(
      { userId, vertical, imageCount: files.length, contextKeys: Object.keys(contextData ?? {}), correlationId },
      'Processing scan upload',
    );

    for (const file of files) {
      // Normalise: auto-rotate from EXIF, resize to 2048px max, strip metadata, JPEG
      const normalised = await sharp(file.buffer)
        .rotate()                                           // honour EXIF orientation
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88, progressive: true, mozjpeg: true })
        .toBuffer();

      const key = `uploads/${userId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.jpg`;
      await uploadToS3(key, normalised, 'image/jpeg');
      uploadedKeys.push(key);
      logger.info({ key, bytes: normalised.length }, 'Image uploaded to S3');
    }

    // Quality check on the uploaded S3 keys (non-blocking — warn, don't reject).
    // The service takes S3 object keys, never image bytes or URLs: that is what
    // stops it being usable as an SSRF proxy.
    let qualityWarning: string | null = null;

    if (uploadedKeys.length > 0) {
      try {
        const data: any = await aiClient.qualityGuard(uploadedKeys, correlationId);

        if (data.passed === false) {
          const issues = (data.results ?? [])
            .filter((r: any) => r.acceptable === false)
            .flatMap((r: any) => r.guidance ?? r.issues ?? []);
          qualityWarning = issues[0] ?? 'Image quality is low. Try re-capturing in better light.';
          logger.warn({ issues, correlationId }, 'Image quality warning');
        }
      } catch (err: any) {
        // Quality guard is best-effort — never block the upload
        logger.warn({ err: err.message, correlationId }, 'Quality guard unavailable — skipping check');
      }
    }

    return { uploadedKeys, qualityWarning };
  },
};
