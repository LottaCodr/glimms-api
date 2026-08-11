import sharp from 'sharp';
import crypto from 'crypto';
import axios from 'axios';
import { uploadToS3 } from '../lib/s3';
import { config } from '../config';
import { logger } from '../lib/logger';

export const scansService = {

  async processUpload(
    files:       Express.Multer.File[],
    userId:      string,
    vertical:    string,
    contextData: Record<string, unknown>,
  ): Promise<{ uploadedKeys: string[]; qualityWarning: string | null }> {

    const uploadedKeys: string[] = [];

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

    // Quality check on the first image (non-blocking — warn, don't reject)
    let qualityWarning: string | null = null;

    if (uploadedKeys.length > 0) {
      try {
        const b64 = files[0].buffer.toString('base64');
        const { data } = await axios.post(
          `${config.ai.qualityGuard}/check`,
          { image_data: b64, context: contextData, vertical },
          { timeout: 8_000 },
        );

        if (!data.passed) {
          qualityWarning = data.guidance ?? 'Image quality is low. Try re-capturing in better light.';
          logger.warn({ issues: data.issues }, 'Image quality warning');
        }
      } catch {
        // Quality guard is best-effort — never block the upload
        logger.warn('Quality guard unavailable — skipping check');
      }
    }

    return { uploadedKeys, qualityWarning };
  },
};
