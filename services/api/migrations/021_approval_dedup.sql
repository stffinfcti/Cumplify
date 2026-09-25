-- One decision per approver per document version. approveDocumentVersion's
-- plain INSERT could record two rows for the same (version, approver) on a
-- double-click or retried mutation, and the publish gate then counts a
-- duplicated approval as two reviews. Collapse pre-existing duplicates first
-- (keep the newest row per pair), then index.
DELETE FROM m1.document_approvals a
  USING m1.document_approvals b
 WHERE a.document_version_id = b.document_version_id
   AND a.approver_id = b.approver_id
   AND a.tenant_id = b.tenant_id
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS document_approvals_version_approver
  ON m1.document_approvals (document_version_id, approver_id);
