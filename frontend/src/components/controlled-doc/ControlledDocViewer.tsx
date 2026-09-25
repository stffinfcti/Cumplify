'use client';

import { useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { buildDocumentHtml, type ContentJson, type DocMeta } from '@/lib/controlled-doc';
import { SecondaryButton } from '@/components/shared';
import styles from './ControlledDocViewer.module.css';
import { parseAwsJson } from '@/lib/aws-json';

/**
 * ControlledDocViewer — sandboxed iframe rendering white controlled docs.
 * Per ims-experience/view-designs.md §9.
 *
 * §7 identification block is MANDATORY on every render — enforced by
 * template.ts which always emits: brand-bar, CONTROLLED stamp, QMS info
 * block (doc ID, title, type, standard, version, date), and footer.
 *
 * The document is WHITE (light-theme, print-ready) — surrounding app
 * chrome is dark. This contrast IS the controlled-doc visual language.
 */

interface ControlledDocViewerProps {
  /** Raw JSON string from getDocumentContent — parsed internally */
  contentRaw: string;
  /** Document ID (used for meta) */
  documentId: string;
  /** Version number stamped in the §7 identification block (the real version
   *  being rendered — never a hardcoded 1) */
  versionNo?: number;
  /** Version creation date stamped in the §7 block — the document's date,
   *  not the view date */
  generatedAt?: string;
  /** Optional className for outer container */
  className?: string;
}

export function ControlledDocViewer({
  contentRaw,
  documentId,
  versionNo,
  generatedAt,
  className,
}: ControlledDocViewerProps) {
  const t = useTranslations('manual');
  const { user } = useAuth();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Parse content and build HTML via template.ts
  const html = useMemo(() => {
    try {
      const content: ContentJson = parseAwsJson<ContentJson>(contentRaw);

      // Build meta from content + context
      const meta: DocMeta = {
        title:
          content.kind === 'correlation_matrix'
            ? 'Correlation Matrix'
            : content.kind === 'master_list'
              ? 'Document Master List'
              : 'IMS Manual',
        documentId,
        versionNo: versionNo ?? 1,
        docType:
          content.kind === 'correlation_matrix'
            ? 'CORRELATION_MATRIX'
            : content.kind === 'form_record'
              ? 'FORM_RECORD'
              : 'MANUAL',
        standard: content.frontMatter?.scope?.standards?.join(', ') ?? 'IMS',
        tenantName: user?.email?.split('@')[1] ?? undefined,
        generatedAt: generatedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      };

      return buildDocumentHtml(meta, content);
    } catch {
      return `<html><body><p style="color:red;padding:24px;">${t('renderFailed')}</p></body></html>`;
    }
  }, [contentRaw, documentId, versionNo, generatedAt, user?.email, t]);

  function handlePrint() {
    iframeRef.current?.contentWindow?.print();
  }

  return (
    <div className={`${styles.container} ${className ?? ''}`}>
      <div className={styles.toolbar}>
        <SecondaryButton onClick={handlePrint}>{t('print')}</SecondaryButton>
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-same-origin"
        className={styles.iframe}
        title={t('viewerTitle')}
      />
    </div>
  );
}
