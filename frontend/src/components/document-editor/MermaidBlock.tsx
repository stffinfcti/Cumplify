'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import styles from './MermaidBlock.module.css';

/**
 * MermaidBlock — renders mermaid source as inline SVG diagram.
 * Per ims-experience/view-designs.md §13.5.
 *
 * - Stores mermaid source in the code content.
 * - Renders inline as SVG (mermaid.render() client-side).
 * - Edit mode: click diagram → reveals code editor; blur → re-renders SVG.
 * - Dependency: mermaid (MIT, tech.md approved).
 */

interface MermaidBlockProps {
  /** Mermaid diagram source code */
  source: string;
  /** Called when source is edited */
  onUpdate?: (newSource: string) => void;
  /** Read-only mode */
  readOnly?: boolean;
}

export function MermaidBlock({ source, onUpdate, readOnly = false }: MermaidBlockProps) {
  const t = useTranslations('editor');
  const [svg, setSvg] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [localSource, setLocalSource] = useState(source);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`);

  const renderDiagram = useCallback(async (src: string) => {
    try {
      setError(null);
      // Dynamic import — mermaid is heavy; only load when needed
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        // 'strict' (default is 'loose' since mermaid v10) — diagram source is
        // user-authored content rendered as SVG; never let labels carry
        // HTML/JS into the DOM.
        securityLevel: 'strict',
        theme: 'dark',
        themeVariables: {
          primaryColor: 'rgb(0, 101, 248)',
          primaryTextColor: 'rgb(252, 252, 252)',
          primaryBorderColor: 'rgb(49, 53, 58)',
          lineColor: 'rgb(174, 180, 188)',
          secondaryColor: 'rgb(35, 40, 46)',
          tertiaryColor: 'rgb(33, 37, 44)',
        },
      });
      const { svg: rendered } = await mermaid.render(idRef.current, src);
      setSvg(rendered);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Diagram render failed');
      setSvg('');
    }
  }, []);

  useEffect(() => {
    if (source) renderDiagram(source);
  }, [source, renderDiagram]);

  function handleEditClick() {
    if (readOnly) return;
    setEditing(true);
    setLocalSource(source);
  }

  function handleBlur() {
    setEditing(false);
    if (localSource !== source) {
      onUpdate?.(localSource);
      renderDiagram(localSource);
    }
  }

  if (editing) {
    return (
      <div className={styles.container}>
        <textarea
          className={styles.codeEditor}
          value={localSource}
          onChange={(e) => setLocalSource(e.target.value)}
          onBlur={handleBlur}
          autoFocus
          rows={Math.max(5, localSource.split('\n').length + 1)}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div
      className={styles.container}
      ref={containerRef}
      onClick={handleEditClick}
      role={readOnly ? undefined : 'button'}
      tabIndex={readOnly ? undefined : 0}
      onKeyDown={(e) => {
        if (!readOnly && (e.key === 'Enter' || e.key === ' ')) handleEditClick();
      }}
    >
      {svg ? (
        <div className={styles.diagram} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : error ? (
        <div className={styles.error}>
          <span className={styles.errorLabel}>{t('mermaidError')}</span>
          <code className={styles.errorMsg}>{error}</code>
        </div>
      ) : (
        <div className={styles.placeholder}>{t('mermaidLoading')}</div>
      )}
    </div>
  );
}
