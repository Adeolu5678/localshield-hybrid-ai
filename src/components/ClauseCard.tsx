import { useState } from 'react';
import type { RiskClause } from '../types/analysis';

interface ClauseCardProps {
  clause: RiskClause;
}

export function ClauseCard({ clause }: ClauseCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(clause.redlineProposal);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={`clause-card severity-${clause.severity}`}>
      <div className="clause-header">
        <div className="clause-title-group">
          <span className={`sev-pill sev-${clause.severity}`}>
            {clause.severity.toUpperCase()}
          </span>
          <span className="cat-pill">{clause.category}</span>
          <h4>{clause.title}</h4>
        </div>
        <span className="mono clause-id">{clause.id}</span>
      </div>

      <blockquote className="clause-excerpt">“{clause.excerpt}”</blockquote>

      <p className="clause-rationale">
        <strong>Risk Rationale:</strong> {clause.rationale}
      </p>

      <div className="redline-box">
        <div className="redline-head">
          <span>Suggested Redline Counter-Proposal</span>
          <button type="button" className="btn-inline" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy Redline'}
          </button>
        </div>
        <p>{clause.redlineProposal}</p>
      </div>
    </article>
  );
}
