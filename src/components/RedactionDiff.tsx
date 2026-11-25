import { useState } from 'react';
import type { PiiCategory, RedactionResult } from '../types/analysis';

interface RedactionDiffProps {
  redaction: RedactionResult;
}

const CATEGORY_ORDER: PiiCategory[] = [
  'API_SECRET',
  'SSN',
  'CARD',
  'IBAN',
  'EMAIL',
  'PHONE',
  'IPV4',
  'ADDRESS'
];

export function RedactionDiff({ redaction }: RedactionDiffProps) {
  const [view, setView] = useState<'redacted' | 'vault'>('redacted');

  const activeCategories = CATEGORY_ORDER.filter(
    (cat) => redaction.countsByCategory[cat] > 0
  );

  return (
    <div className="redaction-panel">
      <div className="panel-header-row">
        <div>
          <h3>Local Zero-Leakage PII Vault</h3>
          <p className="muted-sm">
            {redaction.totalMasked} sensitive item(s) masked deterministically in
            your browser before model inference.
          </p>
        </div>
        <div className="tab-group" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'redacted'}
            className={`tab-btn ${view === 'redacted' ? 'active' : ''}`}
            onClick={() => setView('redacted')}
          >
            Redacted Payload
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'vault'}
            className={`tab-btn ${view === 'vault' ? 'active' : ''}`}
            onClick={() => setView('vault')}
          >
            Local Vault ({Object.keys(redaction.vault).length})
          </button>
        </div>
      </div>

      {activeCategories.length > 0 && (
        <div className="pii-chips">
          {activeCategories.map((cat) => (
            <span key={cat} className="pii-chip mono">
              {cat}: {redaction.countsByCategory[cat]}
            </span>
          ))}
        </div>
      )}

      {view === 'redacted' ? (
        <pre className="redacted-preview mono">{redaction.redactedText}</pre>
      ) : (
        <div className="vault-table-wrap">
          {Object.keys(redaction.vault).length === 0 ? (
            <p className="muted-sm">No PII or secrets detected in current text.</p>
          ) : (
            <table className="vault-table mono">
              <thead>
                <tr>
                  <th>Mask Token (Safe for Cloud)</th>
                  <th>Original Value (Browser-Only)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(redaction.vault).map(([token, original]) => (
                  <tr key={token}>
                    <td className="token-cell">{token}</td>
                    <td>{original}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
