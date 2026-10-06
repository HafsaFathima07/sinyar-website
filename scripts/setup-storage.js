import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'sinyar-files';
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: buckets, error: listError } = await supabase.storage.listBuckets();
if (listError) throw listError;
if (!buckets.some(item => item.name === bucket)) {
  const { error } = await supabase.storage.createBucket(bucket, { public: false, fileSizeLimit: 4 * 1024 * 1024, allowedMimeTypes: ['application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/csv'] });
  if (error) throw error;
  console.log(`Created private bucket ${bucket}.`);
} else {
  console.log(`Private bucket ${bucket} already exists; no changes made.`);
}
