CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_number TEXT NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    report_week TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_id, project_number)
);

CREATE TABLE IF NOT EXISTS material_items (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sno TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    quotation_received TEXT NOT NULL DEFAULT '',
    po_status TEXT NOT NULL DEFAULT '',
    advance_payment TEXT NOT NULL DEFAULT '',
    sample_submission_date TEXT NOT NULL DEFAULT '',
    client_approval TEXT NOT NULL DEFAULT '',
    delivery_eta TEXT NOT NULL DEFAULT '',
    remarks TEXT NOT NULL DEFAULT '',
    cost TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS files (
    storage_key TEXT PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotations (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    quote_ref TEXT NOT NULL DEFAULT '',
    project_number TEXT NOT NULL DEFAULT '',
    vendor TEXT NOT NULL DEFAULT '',
    quote_date TEXT NOT NULL DEFAULT '',
    valid_until TEXT NOT NULL DEFAULT '',
    amount TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending',
    document_key TEXT REFERENCES files(storage_key) ON DELETE SET NULL,
    document_name TEXT,
    document_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS procurement_items (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    purchase_order TEXT NOT NULL DEFAULT '',
    supplier TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    order_date TEXT NOT NULL DEFAULT '',
    delivery_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE procurement_items ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id);
CREATE INDEX IF NOT EXISTS projects_number_idx ON projects(project_number);
CREATE INDEX IF NOT EXISTS materials_project_idx ON material_items(project_id);
CREATE INDEX IF NOT EXISTS quotations_owner_idx ON quotations(owner_id);
CREATE INDEX IF NOT EXISTS quotations_project_idx ON quotations(project_id);
CREATE INDEX IF NOT EXISTS procurement_owner_idx ON procurement_items(owner_id);
CREATE INDEX IF NOT EXISTS procurement_project_idx ON procurement_items(project_id);
CREATE INDEX IF NOT EXISTS files_owner_idx ON files(owner_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
