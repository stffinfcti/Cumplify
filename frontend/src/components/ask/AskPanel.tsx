'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useGraphQL } from '@/lib/api';
import { ClauseChip, PrimaryButton, ErrorState } from '@/components/shared';
import {
  type Standard,
  type AskMessage,
  getMessages,
  getSelectedStandard,
  setSelectedStandard,
  addUserMessage,
  addAssistantMessage,
  subscribe as storeSubscribe,
} from '@/lib/ask-store';
import { buildChipUrls, type ChipType } from '@/lib/ask-chips';
import styles from './AskPanel.module.css';

/**
 * AskPanel — view-designs.md §4.
 * Full page at /ask, overlay (420px right sheet) elsewhere.
 * ASK-2: routes question to askISO9001|14001|45001 (question text ONLY, never queryVector).
 * ASK-3: CitationRow with ClauseChip per citation; citation-or-silence banner.
 * ASK-4: action chips navigate with URL-param prefill.
 * ASK-5: answers arrive in profile locale (no client translation).
 * State persists across open/close within session (client store).
 */

const STANDARDS: Standard[] = ['ISO9001', 'ISO14001', 'ISO45001'];

const STANDARD_LABELS: Record<Standard, string> = {
  ISO9001: '9001',
  ISO14001: '14001',
  ISO45001: '45001',
};

/** Map standard to the correct GraphQL query name */
function queryForStandard(standard: Standard): string {
  const map: Record<Standard, string> = {
    ISO9001: 'askISO9001',
    ISO14001: 'askISO14001',
    ISO45001: 'askISO45001',
  };
  return map[standard];
}

/** Extract clauseRef citations from answer text — ISO clause numbers are
 * always 4.x–10.x; requiring the leading segment to be 4–10 keeps version
 * numbers and decimals out of the citation row. */
function extractCitations(text: string): string[] {
  const matches = text.match(/\b(?:[4-9]|10)(?:\.\d{1,2}){1,3}\b/g);
  return matches ? [...new Set(matches)] : [];
}

export function AskPanel() {
  const t = useTranslations('ask');
  const router = useRouter();
  const { query: gqlQuery } = useGraphQL();
  const [messages, setMessages] = useState<AskMessage[]>(getMessages);
  const [standard, setStandard] = useState<Standard>(getSelectedStandard);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sync with store
  useEffect(() => {
    return storeSubscribe(() => {
      setMessages(getMessages());
      setStandard(getSelectedStandard());
    });
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleStandardChange = useCallback((s: Standard) => {
    setSelectedStandard(s);
    setStandard(s);
  }, []);

  // Last question sent — lets the error retry re-run the actual request
  // instead of the old dead "clear the error" retry.
  const lastQuestionRef = useRef<string | null>(null);

  async function sendQuestion(text: string) {
    setError('');
    setLoading(true);
    try {
      // ASK-2: question text ONLY, never queryVector (ASK-7)
      const queryName = queryForStandard(standard);
      const data = await gqlQuery<Record<string, string>>(
        `query Ask($question: String!) { ${queryName}(question: $question) }`,
        { question: text },
      );
      const answer = data[queryName] ?? '';
      const citations = extractCitations(answer);
      addAssistantMessage(answer, standard, citations);
    } catch (err) {
      setError((err as Error).message || t('error'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    lastQuestionRef.current = text;
    addUserMessage(text, standard);
    await sendQuestion(text);
  }

  function handleRetry() {
    if (lastQuestionRef.current) void sendQuestion(lastQuestionRef.current);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleChipClick(url: string) {
    router.push(url);
  }

  return (
    <div className={styles.panel}>
      {/* Message list */}
      <div className={styles.messages} role="log" aria-label={t('title')}>
        {messages.map((msg) =>
          msg.role === 'user' ? (
            <div key={msg.id} className={styles.userMsg}>
              {msg.content}
            </div>
          ) : (
            <div key={msg.id} className={styles.answer}>
              <div className={styles.answerBody}>{msg.content}</div>
              {/* ASK-3: Citation row */}
              {msg.citations.length > 0 ? (
                <div className={styles.citationRow}>
                  {msg.citations.map((ref) => (
                    <ClauseChip key={ref} standard={msg.standard} clauseRef={ref} />
                  ))}
                </div>
              ) : (
                <span className={styles.generalGuidanceBanner}>{t('generalGuidance')}</span>
              )}
              {/* ASK-4: Action chips */}
              <div className={styles.chipRow}>
                {buildChipUrls(msg.standard, msg.content).map((chip) => (
                  <button
                    key={chip.type}
                    className={styles.actionChip}
                    onClick={() => handleChipClick(chip.url)}
                    type="button"
                  >
                    {t(chipLabel(chip.type))}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
        {loading && <div className={styles.shimmer} aria-label={t('loading')} />}
        {error && <ErrorState onRetry={handleRetry} />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className={styles.inputArea}>
        {/* Standard selector: segmented pill */}
        <div className={styles.standardSelector} role="radiogroup" aria-label={t('selectStandard')}>
          {STANDARDS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === standard}
              className={`${styles.standardBtn} ${s === standard ? styles.standardBtnActive : ''}`}
              onClick={() => handleStandardChange(s)}
            >
              {STANDARD_LABELS[s]}
            </button>
          ))}
        </div>
        <div className={styles.chatRow}>
          <textarea
            className={styles.chatInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            rows={1}
          />
          <PrimaryButton
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!input.trim() || loading}
          >
            {t('send')}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function chipLabel(type: ChipType): string {
  const map: Record<ChipType, string> = {
    draftProcedure: 'chipDraftProcedure',
    raiseNc: 'chipRaiseNc',
    addRisk: 'chipAddRisk',
  };
  return map[type];
}
