import { useEffect, useRef, useState } from 'react';
import {
  createClauseNegotiator,
  type ClauseNegotiator,
  type ModelFactory
} from '../lib/hybridRouter';
import type {
  ChromeNanoAvailability,
  ClauseNegotiationMessage,
  HybridPolicyMode,
  RiskClause
} from '../types/analysis';

interface ClauseNegotiationDrawerProps {
  clause: RiskClause | null;
  redactedDocumentContext: string;
  policyMode: HybridPolicyMode;
  isOnline: boolean;
  chromeNanoAvailability: ChromeNanoAvailability;
  useSimulatedSandbox: boolean;
  modelFactory?: ModelFactory;
  onClose: () => void;
  onApplySuggestion: (clauseId: string, suggestedRedline: string) => void;
}

const QUICK_ACTIONS = [
  {
    label: 'Stricter counter-proposal',
    prompt:
      'Draft a stricter customer-protective counter-proposal for this clause in 2-3 clean contract sentences.'
  },
  {
    label: 'Balanced compromise',
    prompt:
      'Draft a balanced commercial compromise redline that vendor legal is likely to accept quickly.'
  },
  {
    label: 'Explain worst-case risk',
    prompt:
      'Explain the concrete worst-case financial or operational risk of leaving this clause unedited.'
  }
];

function formatRouteBadge(
  source?: ClauseNegotiationMessage['inferenceSource']
): { label: string; className: string } {
  switch (source) {
    case 'on_device':
      return { label: 'ON-DEVICE', className: 'badge badge-emerald' };
    case 'in_cloud':
      return { label: 'IN-CLOUD', className: 'badge badge-sky' };
    case 'simulated':
      return { label: 'SIMULATED', className: 'badge badge-sky' };
    case 'local_heuristic':
      return { label: 'LOCAL HEURISTIC', className: 'badge badge-amber' };
    default:
      return { label: 'HYBRID', className: 'badge badge-slate' };
  }
}

export function ClauseNegotiationDrawer({
  clause,
  redactedDocumentContext,
  policyMode,
  isOnline,
  chromeNanoAvailability,
  useSimulatedSandbox,
  modelFactory,
  onClose,
  onApplySuggestion
}: ClauseNegotiationDrawerProps) {
  const [messages, setMessages] = useState<ClauseNegotiationMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [appliedIndex, setAppliedIndex] = useState<number | null>(null);

  const negotiatorRef = useRef<ClauseNegotiator | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setInput('');
    setStreamingText('');
    setErrorText(null);
    setAppliedIndex(null);

    if (!clause) {
      negotiatorRef.current = null;
      return;
    }

    negotiatorRef.current = createClauseNegotiator({
      clause,
      redactedDocumentContext,
      policyMode,
      isOnline,
      chromeNanoAvailability,
      useSimulatedSandbox,
      modelFactory
    });
  }, [
    clause,
    redactedDocumentContext,
    policyMode,
    isOnline,
    chromeNanoAvailability,
    useSimulatedSandbox,
    modelFactory
  ]);

  if (!clause) return null;

  const effectiveMode = negotiatorRef.current?.effectiveMode ?? policyMode;

  const sendPrompt = async (promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed || !negotiatorRef.current || isSending) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsSending(true);
    setStreamingText('');
    setErrorText(null);
    setInput('');

    const optimisticUser: ClauseNegotiationMessage = {
      role: 'user',
      text: trimmed,
      timestamp: new Date().toISOString()
    };
    setMessages((prev) => [...prev, optimisticUser]);

    try {
      await negotiatorRef.current.sendMessage(trimmed, {
        signal: controller.signal,
        onStreamChunk: (chunk) => {
          setStreamingText((prev) => prev + chunk);
        }
      });
      setMessages(negotiatorRef.current.getHistory());
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setErrorText('Negotiation turn cancelled.');
      } else {
        setErrorText(
          err instanceof Error
            ? err.message
            : 'Negotiation turn failed.'
        );
      }
    } finally {
      setIsSending(false);
      setStreamingText('');
      abortRef.current = null;
    }
  };

  const handleApply = (idx: number, text: string) => {
    onApplySuggestion(clause.id, text.trim());
    setAppliedIndex(idx);
    setTimeout(() => setAppliedIndex(null), 2000);
  };

  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Negotiate ${clause.title}`}
    >
      <div className="drawer-panel">
        <div className="drawer-header">
          <div>
            <div className="drawer-title-row">
              <span className="badge badge-sky mono">
                {effectiveMode.toUpperCase()}
              </span>
              <span className={`sev-pill sev-${clause.severity}`}>
                {clause.severity.toUpperCase()}
              </span>
              <span className="muted-sm mono">{clause.id}</span>
            </div>
            <h3>Negotiate: {clause.title}</h3>
            <p className="muted-sm">
              Multi-turn <code>startChat()</code> session strictly against the
              PII-redacted document vault.
            </p>
          </div>
          <button
            type="button"
            className="btn-inline"
            onClick={() => {
              abortRef.current?.abort();
              onClose();
            }}
          >
            Close
          </button>
        </div>

        <div className="drawer-clause-context">
          <div className="muted-sm">
            <strong>Excerpt:</strong> “{clause.excerpt}”
          </div>
          <div className="muted-sm">
            <strong>Baseline Redline:</strong> {clause.redlineProposal}
          </div>
        </div>

        <div className="quick-chips-row">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className="sample-pill"
              disabled={isSending}
              onClick={() => void sendPrompt(action.prompt)}
            >
              {action.label}
            </button>
          ))}
        </div>

        <div className="drawer-messages" aria-live="polite">
          {messages.length === 0 && !isSending && (
            <p className="muted-sm drawer-empty">
              Select a quick-action chip above or ask for a tailored counter-proposal,
              fallback cap, or negotiation talking point.
            </p>
          )}

          {messages.map((msg, idx) => {
            const route = formatRouteBadge(msg.inferenceSource);
            return (
              <div
                key={`${msg.timestamp}-${idx}`}
                className={`chat-bubble chat-${msg.role}`}
              >
                <div className="chat-bubble-head">
                  <span className="mono">
                    {msg.role === 'user' ? 'YOU' : 'LOCALSHIELD NEGOTIATOR'}
                  </span>
                  {msg.role === 'model' && (
                    <span className={route.className}>{route.label}</span>
                  )}
                </div>
                <div className="chat-bubble-text">{msg.text}</div>
                {msg.role === 'model' && (
                  <div className="chat-bubble-actions">
                    <button
                      type="button"
                      className="btn-inline btn-inline-emerald"
                      onClick={() => handleApply(idx, msg.text)}
                    >
                      {appliedIndex === idx
                        ? 'Applied to Redline'
                        : 'Apply Suggestion to Redline'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {isSending && (
            <div className="chat-bubble chat-model chat-streaming">
              <div className="chat-bubble-head">
                <span className="mono">LOCALSHIELD NEGOTIATOR</span>
                <span className="badge badge-sky">STREAMING...</span>
              </div>
              <div className="chat-bubble-text">
                {streamingText || 'Drafting negotiation response...'}
              </div>
            </div>
          )}
        </div>

        {errorText && (
          <div className="error-banner" role="alert">
            {errorText}
          </div>
        )}

        <form
          className="drawer-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            void sendPrompt(input);
          }}
        >
          <input
            type="text"
            className="drawer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask for a counter-proposal, fallback cap, or risk explanation..."
            disabled={isSending}
          />
          {isSending ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              className="btn-primary btn-compact"
              disabled={!input.trim()}
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
