import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

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

export async function getPresignedDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }),
    { expiresIn: config.aws.presignExpiry },
  );
}

export async function deleteFromS3(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
}
