import { useEffect, useRef, useState } from 'react';
import type { ClauseRedlineDecision } from '../lib/redlineDiff';
import type { RiskClause } from '../types/analysis';
import type { ClauseDeltaBadge } from './HybridDeltaPanel';

interface ClauseCardProps {
  clause: RiskClause;
  decision?: ClauseRedlineDecision;
  deltaBadge?: ClauseDeltaBadge;
  isExpanded?: boolean;
  isSelected?: boolean;
  onToggleExpand?: () => void;
  onDecisionChange?: (clauseId: string, next: ClauseRedlineDecision) => void;
  onOpenNegotiate?: (clause: RiskClause) => void;
}

export function ClauseCard({
  clause,
  decision,
  deltaBadge,
  isExpanded = false,
  isSelected = false,
  onToggleExpand,
  onDecisionChange,
  onOpenNegotiate
}: ClauseCardProps) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState(isExpanded);
  const expanded = onToggleExpand ? isExpanded : internalExpanded;
  const toggleExpand = onToggleExpand ?? (() => setInternalExpanded((v) => !v));
  const effectiveRedline =
    decision?.customRedline !== undefined && decision.customRedline.length > 0
      ? decision.customRedline
      : clause.redlineProposal;
  const [draftRedline, setDraftRedline] = useState(effectiveRedline);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setIsEditing(false);
    setDraftRedline(effectiveRedline);
  }, [clause.id]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const status = decision?.status ?? 'pending';
  const isDecided = status === 'accepted' || status === 'rejected';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(effectiveRedline);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1600);
    } catch {
      setCopied(false);
    }
  };

  const handleAccept = () => {
    onDecisionChange?.(clause.id, {
      status: status === 'accepted' ? 'pending' : 'accepted',
      customRedline: decision?.customRedline
    });
  };

  const handleReject = () => {
    onDecisionChange?.(clause.id, {
      status: status === 'rejected' ? 'pending' : 'rejected',
      customRedline: decision?.customRedline
    });
  };

  const handleStartEdit = () => {
    setDraftRedline(effectiveRedline);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    const trimmed = draftRedline.trim();
    onDecisionChange?.(clause.id, {
      status: 'accepted',
      customRedline: trimmed || clause.redlineProposal
    });
    setIsEditing(false);
  };

  return (
    <article
      id={`clause-card-${clause.id}`}
      className={`clause-card severity-${clause.severity} clause-decision-${status}${
        expanded ? ' is-expanded' : ' is-collapsed'
      }${isSelected ? ' is-selected' : ''}`}
    >
      <div
        className="clause-header clause-header-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpand();
          }
        }}
      >
        <div className="clause-title-group">
          <span className={`sev-pill sev-${clause.severity}`}>
            {clause.severity.toUpperCase()}
          </span>
          <h4
            className="clause-title-text"
            style={
              isDecided
                ? { textDecoration: 'line-through', opacity: 0.65 }
                : undefined
            }
          >
            {clause.title}
          </h4>
          {status === 'accepted' && (
            <span className="decision-pill decision-accepted">Accepted</span>
          )}
          {status === 'rejected' && (
            <span className="decision-pill decision-rejected">Dismissed</span>
          )}
        </div>
        <div
          className="clause-quick-actions"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {isDecided ? (
            <button
              type="button"
              className="btn-inline btn-quick"
              title="Undo decision"
              onClick={() =>
                onDecisionChange?.(clause.id, {
                  status: 'pending',
                  customRedline: decision?.customRedline
                })
              }
            >
              Undo
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn-inline btn-quick"
                title="Apply fix"
                onClick={handleAccept}
              >
                ✓ Apply Fix
              </button>
              <button
                type="button"
                className="btn-inline btn-quick"
                title="Dismiss issue"
                onClick={handleReject}
              >
                ✕ Dismiss
              </button>
              <button
                type="button"
                className="clause-chevron-btn"
                aria-label={expanded ? 'Collapse issue' : 'Expand issue'}
                onClick={toggleExpand}
              >
                {expanded ? '▾' : '▸'}
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="clause-body">
          <div className="clause-meta-row">
            <span className="cat-pill">{clause.category}</span>
            {deltaBadge?.kind === 'new' && (
              <span className="delta-origin-pill delta-origin-new">
                NEW IN CLOUD
              </span>
            )}
            {deltaBadge?.kind === 'upgraded' && (
              <span className="delta-origin-pill delta-origin-upgraded">
                UPGRADED
                {deltaBadge.previousSeverity
                  ? `: ${deltaBadge.previousSeverity.toUpperCase()} -> ${clause.severity.toUpperCase()}`
                  : ' IN CLOUD'}
              </span>
            )}
            <span className="mono clause-id">{clause.id}</span>
          </div>

          <blockquote className="clause-excerpt">“{clause.excerpt}”</blockquote>

          <p className="clause-rationale">
            <strong>Risk Rationale:</strong> {clause.rationale}
          </p>

          <div className="redline-box">
            <div className="redline-head">
              <span>
                {decision?.customRedline
                  ? 'Custom Redline Counter-Proposal'
                  : 'Suggested Redline Counter-Proposal'}
              </span>
              <div className="redline-actions">
                <button
                  type="button"
                  className="btn-inline"
                  onClick={handleStartEdit}
                >
                  Edit
                </button>
                {onOpenNegotiate && (
                  <button
                    type="button"
                    className="btn-inline btn-inline-accent"
                    onClick={() => onOpenNegotiate(clause)}
                  >
                    Negotiate
                  </button>
                )}
                <button type="button" className="btn-inline" onClick={handleCopy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {isEditing ? (
              <div className="redline-editor">
                <textarea
                  className="redline-textarea mono"
                  rows={3}
                  value={draftRedline}
                  onChange={(e) => setDraftRedline(e.target.value)}
                  aria-label={`Edit redline for ${clause.title}`}
                />
                <div className="redline-editor-actions">
                  <button
                    type="button"
                    className="btn-inline btn-inline-emerald"
                    onClick={handleSaveEdit}
                  >
                    Save &amp; Accept
                  </button>
                  <button
                    type="button"
                    className="btn-inline"
                    onClick={() => setIsEditing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p>{effectiveRedline}</p>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
