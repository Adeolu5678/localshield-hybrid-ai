import { useMemo, useState } from 'react';
import { restoreFromVault } from '../lib/piiRedactor';
import {
  compileRedlinedDocument,
  computeWordDiff,
  type ClauseRedlineDecision
} from '../lib/redlineDiff';
import type { RedactionResult, RiskClause } from '../types/analysis';

interface ContractDiffViewProps {
  redaction: RedactionResult;
  clauses: RiskClause[];
  decisions: Record<string, ClauseRedlineDecision>;
  restoreVaultForView: boolean;
  onToggleRestoreVault: (next: boolean) => void;
  onExport?: () => void;
}

export function ContractDiffView({
  redaction,
  clauses,
  decisions,
  restoreVaultForView,
  onToggleRestoreVault,
  onExport
}: ContractDiffViewProps) {
  const [displayMode, setDisplayMode] = useState<'diff' | 'clean'>('clean');

  const compiled = useMemo(
    () => compileRedlinedDocument(redaction.redactedText, clauses, decisions),
    [redaction.redactedText, clauses, decisions]
  );

  const displayedOriginal = useMemo(
    () =>
      restoreVaultForView
        ? restoreFromVault(redaction.redactedText, redaction.vault)
        : redaction.redactedText,
    [redaction.redactedText, redaction.vault, restoreVaultForView]
  );

  const displayedCompiled = useMemo(
    () =>
      restoreVaultForView
        ? restoreFromVault(compiled.compiledText, redaction.vault)
        : compiled.compiledText,
    [compiled.compiledText, redaction.vault, restoreVaultForView]
  );

  const diffSegments = useMemo(
    () => computeWordDiff(displayedOriginal, displayedCompiled),
    [displayedOriginal, displayedCompiled]
  );

  return (
    <section
      className="panel-card diff-view-card"
      aria-label="Final Document"
    >
      <div className="panel-header-row">
        <div>
          <span className="telemetry-label">Step 2 · Ready to Export</span>
          <h3>Final Document</h3>
          <p className="muted-sm">
            {compiled.appliedCount} accepted · {compiled.rejectedCount} dismissed ·{' '}
            {compiled.pendingCount} pending
          </p>
        </div>

        <div className="vault-actions-row">
          <label
            className="checkbox-field"
            title="Replaces hidden placeholders like [EMAIL_1] with your real info on this device"
          >
            <input
              type="checkbox"
              checked={restoreVaultForView}
              onChange={(e) => onToggleRestoreVault(e.target.checked)}
            />
            <span>Include Private Details</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={displayMode === 'diff'}
              onChange={(e) => setDisplayMode(e.target.checked ? 'diff' : 'clean')}
            />
            <span>Show changes</span>
          </label>
        </div>
      </div>

      {displayMode === 'diff' ? (
        <div
          className="diff-document-box mono"
          role="region"
          aria-label="Word-level redline diff"
        >
          {diffSegments.map((seg, idx) => {
            if (seg.kind === 'delete') {
              return (
                <del key={idx} className="diff-del">
                  {seg.text}
                </del>
              );
            }
            if (seg.kind === 'insert') {
              return (
                <ins key={idx} className="diff-ins">
                  {seg.text}
                </ins>
              );
            }
            return <span key={idx}>{seg.text}</span>;
          })}
        </div>
      ) : (
        <pre
          className="diff-document-box mono"
          aria-label="Compiled redlined document"
        >
          {displayedCompiled}
        </pre>
      )}

      {onExport && (
        <div
          className="diff-export-footer no-print"
          style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={onExport}
          >
            Export Final Document
          </button>
        </div>
      )}
    </section>
  );
}
