# Sinyar Tracker Suite

The existing HTML UI is served unchanged by an Express backend. Application records are stored in PostgreSQL, sessions use HTTP-only cookies, passwords are bcrypt hashes, and uploaded PDF/Excel files are stored in the configured upload adapter directory rather than in the database.

## Architecture

```text
Browser -> Express API -> PostgreSQL
					-> storage adapter (local development, S3/R2/Supabase extension point)
```

## Local setup

1. Install PostgreSQL and create a database named `sinyar_tracker`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `DATABASE_SSL`, `PG_IP_FAMILY`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `NODE_ENV`, `PORT`, and `FRONTEND_URL`. For Supabase, use the pooler connection string from the dashboard, preferably port `6543` for serverless workloads, and set `DATABASE_SSL=true`.
3. Apply the schema:

```powershell
psql $env:DATABASE_URL -f schema.sql
```

4. Install and run:

```powershell
npm install
npm start
```

Or run the complete local stack with Docker:

```powershell
Copy-Item .env.example .env
# Set SESSION_SECRET, ADMIN_USERNAME, and ADMIN_PASSWORD in .env
docker compose up --build
```

Open `http://localhost:3000/sinyar_enterprise_procurement_and_quotation_tracker_suite%20(2).html`.

For production, put the service behind HTTPS, set `COOKIE_SECURE=true`, use a strong session secret, and replace the local file adapter in `POST /api/files` and `GET /api/files/:key` with S3, Cloudflare R2, or Supabase Storage. PostgreSQL only stores file metadata and storage keys.

## Legacy migration

Export the legacy browser values into a JSON file without deleting the original data, then run:

```powershell
npm run migrate:legacy -- .\legacy-export.json
```

The importer validates each record, inserts users/projects/materials/quotations, and reports per-record failures.

## Production deployment

Provision a managed PostgreSQL database and private object storage, set all variables in `.env.example`, run `npm ci --omit=dev`, run `npm run migrate`, and start with `NODE_ENV=production npm start`. Put the process behind an HTTPS reverse proxy, set `FRONTEND_URL` to the exact public origin, set `COOKIE_SECURE=true`, restrict the database to the application network, and enable database/object-storage backups. For Render or Railway, deploy the repository as a Node service and attach managed PostgreSQL; configure the same environment variables in the platform dashboard.

## Verification

Run `npm test` after PostgreSQL is available. The integration suite uses the configured database and reports authentication, authorization, ownership, concurrency, and file-security cases separately.
