-- One version number per document. Every version writer computes
-- COALESCE(MAX(version_no), 0) + 1 under the parent document's FOR UPDATE
-- lock; this index is the belt for any writer that forgets the lock — a
-- racing second INSERT surfaces a unique-violation instead of a duplicated
-- version row overwriting a sibling's S3 content key. Collapse pre-existing
-- duplicates first (keep the newest row per pair), then index.
DELETE FROM m1.document_versions a
  USING m1.document_versions b
 WHERE a.document_id = b.document_id
   AND a.version_no = b.version_no
   AND a.tenant_id = b.tenant_id
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.id < b.id))
   -- A dup carrying approvals can't be deleted (FK) and mustn't anyway —
   -- two "versions" of one number both reviewed is a real divergence. The
   -- index below fails loudly on those instead of silently picking a winner.
   AND NOT EXISTS (SELECT 1 FROM m1.document_approvals ap
                   WHERE ap.document_version_id = a.id)
   -- Same for distribution rows (002_m1_document_studio FKs to
   -- document_versions too) — otherwise the delete aborts mid-statement
   -- on a raw FK violation instead of the intended unique-index failure.
   AND NOT EXISTS (SELECT 1 FROM m1.document_distribution dd
                   WHERE dd.document_version_id = a.id);

CREATE UNIQUE INDEX IF NOT EXISTS document_versions_document_version_no
  ON m1.document_versions (document_id, version_no);
