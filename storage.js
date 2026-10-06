import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const DEFAULT_BUCKET = 'sinyar-files';

export function createStorage({ provider = process.env.STORAGE_PROVIDER, uploadDir, supabaseUrl, serviceRoleKey, bucket = DEFAULT_BUCKET, isVercel = false, nodeEnv = 'development' }) {
  let client;
  let configurationError;

  function resolve() {
    if (client || configurationError) return;
    const resolvedProvider = provider || (nodeEnv === 'production' || isVercel ? 'supabase' : 'local');
    if (resolvedProvider === 'supabase') {
      const missing = [];
      if (!supabaseUrl) missing.push('SUPABASE_URL');
      if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
      if (!bucket) missing.push('SUPABASE_STORAGE_BUCKET');
      if (missing.length) {
        configurationError = new Error('File storage is not configured');
        configurationError.missing = missing;
        return;
      }
      client = { provider: resolvedProvider, supabase: createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }), bucket };
      return;
    }
    if (resolvedProvider === 'local' && nodeEnv !== 'production' && !isVercel) {
      client = { provider: resolvedProvider, uploadDir };
      return;
    }
    configurationError = new Error('File storage is not configured');
    configurationError.missing = ['STORAGE_PROVIDER'];
  }

  function requireClient() {
    resolve();
    if (configurationError) throw configurationError;
    return client;
  }

  return {
    async init() {
      resolve();
      if (client?.provider === 'local') await fs.mkdir(client.uploadDir, { recursive: true });
    },
    async put(file, extension) {
      const selected = requireClient();
      const key = `files/${new Date().getUTCFullYear()}/${crypto.randomUUID()}.${extension}`;
      if (file.size > MAX_FILE_SIZE) { const error = new Error('File exceeds the 4 MB limit.'); error.status = 413; throw error; }
      if (selected.provider === 'supabase') {
        const { error } = await selected.supabase.storage.from(selected.bucket).upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
        if (error) throw error;
        return { key };
      }
      const destination = path.join(selected.uploadDir, key);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.buffer);
      return { key };
    },
    async getOrSignedUrl(key) {
      const selected = requireClient();
      if (selected.provider === 'supabase') {
        const { data, error } = await selected.supabase.storage.from(selected.bucket).createSignedUrl(key, 60);
        if (error) throw error;
        return data.signedUrl;
      }
      return `file://${path.resolve(selected.uploadDir, key)}`;
    },
    async delete(key) {
      const selected = requireClient();
      if (selected.provider === 'supabase') {
        const { error } = await selected.supabase.storage.from(selected.bucket).remove([key]);
        if (error && !/not found/i.test(error.message)) throw error;
        return;
      }
      await fs.unlink(path.join(selected.uploadDir, key)).catch(() => {});
    },
    async exists(key) {
      const selected = requireClient();
      if (selected.provider === 'supabase') {
        const directory = key.slice(0, key.lastIndexOf('/'));
        const filename = key.slice(key.lastIndexOf('/') + 1);
        const { data, error } = await selected.supabase.storage.from(selected.bucket).list(directory, { search: filename, limit: 1 });
        if (error) throw error;
        return data.some(item => item.name === filename);
      }
      return Boolean(await fs.stat(path.join(selected.uploadDir, key)).catch(() => null));
    },
    configurationError() { resolve(); return configurationError; }
  };
}

export { MAX_FILE_SIZE, DEFAULT_BUCKET };
