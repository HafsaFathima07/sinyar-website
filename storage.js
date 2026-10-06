import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function createStorage({ provider = 'local', uploadDir, endpoint, region, bucket, accessKeyId, secretKey }) {
  if (provider === 's3') {
    if (!bucket || !accessKeyId || !secretKey) throw new Error('S3 storage requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_KEY.');
    const client = new S3Client({ endpoint, region: region || 'auto', forcePathStyle: Boolean(endpoint), credentials: { accessKeyId, secretAccessKey: secretKey } });
    return {
      async init() {},
      async save(file) { const key = crypto.randomUUID(); const body = await fs.readFile(file.path); await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: file.mimetype })); await fs.unlink(file.path).catch(() => {}); return { key }; },
      async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
      async stream(key) { return (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body; }
    };
  }
  if (provider !== 'local') throw new Error('STORAGE_PROVIDER must be local or s3.');
  return {
    async init() { await fs.mkdir(uploadDir, { recursive: true }); },
    async save(file) {
      const key = crypto.randomUUID();
      const destination = path.join(uploadDir, key);
      await fs.rename(file.path, destination);
      return { key, path: destination };
    },
    async remove(key) { await fs.unlink(path.join(uploadDir, key)).catch(() => {}); },
      async stream(key) { return (await import('node:fs')).createReadStream(path.join(uploadDir, key)); }
  };
}
