import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { logger } from './logger';

export const s3 = new S3Client({ region: config.aws.region });

export async function uploadToS3(key: string, body: Buffer, contentType: string): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: config.aws.s3Bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: { uploadedAt: new Date().toISOString() },
  }));
  return `s3://${config.aws.s3Bucket}/${key}`;
}

export async function getPresignedDownloadUrl(key: string, expiresIn = config.aws.presignExpiry): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }),
    { expiresIn },
  );
}

export async function getPresignedUploadUrl(key: string, contentType: string, expiresIn = 900): Promise<{ url: string; expiresAt: Date }> {
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.aws.s3Bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

export async function headObject(key: string) {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
    return {
      exists: true,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      etag: res.ETag?.replace(/"/g, ''),
      lastModified: res.LastModified,
    };
  } catch (err: any) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false } as const;
    }
    throw err;
  }
}

export async function verifyObjectOwnership(key: string, userId: string, sessionId: string): Promise<boolean> {
  // Enforce prefix users/<userId>/sessions/<sessionId>/...
  const expectedPrefix = `users/${userId}/sessions/${sessionId}/`;
  if (!key.startsWith(expectedPrefix)) {
    logger.warn({ key, userId, sessionId }, 'S3 key ownership check failed — prefix mismatch');
    return false;
  }
  // Prevent path traversal
  if (key.includes('..') || key.includes('//')) return false;
  return true;
}

export async function deleteFromS3(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
}

// Helpers per implementation guide §3.2
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB per guide

export function isAllowedImageType(mime: string) {
  return ALLOWED_IMAGE_TYPES.includes(mime.toLowerCase());
}
