'use client';

import { useTranslations } from 'next-intl';
import styles from './ProposalView.module.css';

/**
 * ProposalView — reviewer-grade rendering of a HITL proposal (owner
 * screenshots 2026-07-22: three raw-JSON cards on live surfaces).
 * Per-tool views for the drafting tools; anything unrecognized falls back
 * to the raw draftBody text (prior behavior, byte-identical). The raw JSON
 * stays one disclosure away — approvers audit the exact payload.
 */

interface ParsedProposal {
  tool: string | null;
  args: Record<string, unknown>;
}

function parseProposal(draftBody: string): ParsedProposal | null {
  try {
    const parsed = JSON.parse(draftBody);
    if (!parsed || typeof parsed !== 'object') return null;
    if ('args' in parsed && parsed.args && typeof parsed.args === 'object') {
      return {
        tool: (parsed.tool as string) ?? null,
        args: parsed.args as Record<string, unknown>,
      };
    }
    return { tool: (parsed.tool as string) ?? null, args: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

function Rationale({ text }: { text: unknown }) {
  const t = useTranslations('proposal');
  if (typeof text !== 'string' || !text) return null;
  return (
    <div className={styles.rationale}>
      <span className={styles.fieldLabel}>{t('rationale')}</span>
      <p className={styles.rationaleText}>{text}</p>
    </div>
  );
}

function FieldChip({ label, value }: { label: string; value: unknown }) {
  if (typeof value !== 'string' || !value) return null;
  return (
    <span className={styles.fieldChip}>
      <span className={styles.fieldChipLabel}>{label}</span> {value}
    </span>
  );
}

function SectionDraftView({ args }: { args: Record<string, unknown> }) {
  const t = useTranslations('proposal');
  const sentences = Array.isArray(args.sentences)
    ? (args.sentences as Array<{ text?: string }>)
    : [];
  return (
    <div className={styles.proposal}>
      <div className={styles.chipRow}>
        <FieldChip label={t('section')} value={args.harmonizationKey} />
      </div>
      <p className={styles.prose}>
        {sentences
          .map((s) => s.text ?? '')
          .filter(Boolean)
          .join(' ')}
      </p>
      <Rationale text={args.rationale} />
    </div>
  );
}

function DocDraftView({ args }: { args: Record<string, unknown> }) {
  const t = useTranslations('proposal');
  const sections = Array.isArray(args.sections)
    ? (args.sections as Array<{ clauseRef?: string; heading?: string; body?: string }>)
    : [];
  return (
    <div className={styles.proposal}>
      {typeof args.title === 'string' && <p className={styles.docTitle}>{args.title}</p>}
      <div className={styles.chipRow}>
        <FieldChip label={t('standard')} value={args.standard} />
        <FieldChip label={t('docType')} value={args.docType} />
      </div>
      {sections.map((s, i) => (
        <div key={i} className={styles.docSection}>
          <p className={styles.sectionHeading}>
            {s.clauseRef ? `${s.clauseRef} — ` : ''}
            {s.heading ?? ''}
          </p>
          <p className={styles.prose}>{s.body ?? ''}</p>
        </div>
      ))}
      <Rationale text={args.rationale} />
    </div>
  );
}

function NcDraftView({ args }: { args: Record<string, unknown> }) {
  const t = useTranslations('proposal');
  return (
    <div className={styles.proposal}>
      <div className={styles.chipRow}>
        <FieldChip label={t('standard')} value={args.standard} />
        <FieldChip label={t('clause')} value={args.clauseRef} />
        <FieldChip label={t('severity')} value={args.severity} />
        <FieldChip label={t('source')} value={args.source} />
        <FieldChip label={t('ncType')} value={args.ncType} />
      </div>
      {typeof args.description === 'string' && <p className={styles.prose}>{args.description}</p>}
      {typeof args.containmentNote === 'string' && args.containmentNote && (
        <p className={styles.prose}>
          <span className={styles.fieldLabel}>{t('containment')}</span> {args.containmentNote}
        </p>
      )}
      <Rationale text={args.rationale} />
    </div>
  );
}

function RcaView({ args }: { args: Record<string, unknown> }) {
  const t = useTranslations('proposal');
  const findings = (args.findings ?? {}) as {
    whys?: Array<{ question?: string; answer?: string }>;
    categories?: Array<{ category?: string; causes?: string[] }>;
    tree?: Array<{ event?: string; causes?: string[] }>;
  };
  return (
    <div className={styles.proposal}>
      <div className={styles.chipRow}>
        <FieldChip label={t('method')} value={args.method} />
      </div>
      {findings.whys && findings.whys.length > 0 && (
        <ol className={styles.whysList}>
          {findings.whys.map((w, i) => (
            <li key={i}>
              <span className={styles.fieldLabel}>{w.question ?? ''}</span>
              <p className={styles.prose}>{w.answer ?? ''}</p>
            </li>
          ))}
        </ol>
      )}
      {findings.categories && findings.categories.length > 0 && (
        <div className={styles.proposal}>
          {findings.categories.map((c, i) => (
            <p key={i} className={styles.prose}>
              <span className={styles.fieldLabel}>{c.category ?? ''}</span>{' '}
              {(c.causes ?? []).join('; ')}
            </p>
          ))}
        </div>
      )}
      {findings.tree && findings.tree.length > 0 && (
        <div className={styles.proposal}>
          {findings.tree.map((n, i) => (
            <p key={i} className={styles.prose}>
              <span className={styles.fieldLabel}>{n.event ?? ''}</span>{' '}
              {(n.causes ?? []).join('; ')}
            </p>
          ))}
        </div>
      )}
      {typeof args.rootCauseSummary === 'string' && (
        <p className={styles.rootCause}>
          <span className={styles.fieldLabel}>{t('rootCause')}</span> {args.rootCauseSummary}
        </p>
      )}
      <Rationale text={args.rationale} />
    </div>
  );
}

function FindingView({ args }: { args: Record<string, unknown> }) {
  const t = useTranslations('proposal');
  return (
    <div className={styles.proposal}>
      <div className={styles.chipRow}>
        <FieldChip label={t('findingType')} value={args.findingType} />
        <FieldChip label={t('clause')} value={(args.clause ?? args.clauseRef) as string} />
        <FieldChip label={t('standard')} value={args.standard} />
      </div>
      {typeof args.description === 'string' && <p className={styles.prose}>{args.description}</p>}
      <Rationale text={args.rationale} />
    </div>
  );
}

const TOOL_VIEWS: Record<string, (props: { args: Record<string, unknown> }) => React.JSX.Element> =
  {
    'manual-section-draft': SectionDraftView,
    'doc-draft': DocDraftView,
    'nc-draft-write': NcDraftView,
    'rca-write': RcaView,
    'audit-finding-write': FindingView,
  };

export function ProposalView({ draftBody }: { draftBody: string }) {
  const t = useTranslations('proposal');
  const parsed = parseProposal(draftBody);
  const View = parsed?.tool ? TOOL_VIEWS[parsed.tool] : undefined;

  if (!parsed || !View) {
    // Fallback: prior behavior — the body verbatim
    return <p className={styles.rawBody}>{draftBody}</p>;
  }

  return (
    <div data-testid="proposal-view">
      <View args={parsed.args} />
      <details className={styles.rawDetails}>
        <summary className={styles.rawSummary}>{t('rawJson')}</summary>
        <pre className={styles.rawPre}>{JSON.stringify(parsed.args, null, 2)}</pre>
      </details>
    </div>
  );
}
