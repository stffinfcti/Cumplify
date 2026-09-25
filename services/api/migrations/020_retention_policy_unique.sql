-- One retention policy per (tenant, record_type). Re-running
-- createRetentionPolicy previously inserted a second row for the same
-- record_type, leaving getRetentionPolicy to pick an arbitrary winner.
-- Collapse any pre-existing duplicates first (keep the newest), then index.
DELETE FROM m4.retention_policies a
  USING m4.retention_policies b
 WHERE a.tenant_id = b.tenant_id
   AND a.record_type = b.record_type
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS retention_policies_tenant_record_type
  ON m4.retention_policies (tenant_id, record_type);
