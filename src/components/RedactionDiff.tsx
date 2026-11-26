import { useState, type ReactNode } from 'react';
import type {
  PiiCategory,
  RedactionResult,
  SemanticPiiReport
} from '../types/analysis';

interface RedactionDiffProps {
  redaction: RedactionResult;
  semanticPii?: SemanticPiiReport;
}

const CATEGORY_ORDER: PiiCategory[] = [
  'PEM_KEY',
  'AWS_KEY',
  'JWT',
  'API_SECRET',
  'SSN',
  'EIN',
  'CARD',
  'IBAN',
  'EMAIL',
  'PHONE',
  'IPV4',
  'IPV6',
  'ADDRESS',
  'CUSTOM',
  'PERSON',
  'ORG',
  'CODENAME'
];

const TOKEN_SPLIT_RE =
  /(\[(?:PEM_KEY|API_SECRET|AWS_KEY|JWT|SSN|EIN|CARD|IBAN|EMAIL|PHONE|IPV4|IPV6|ADDRESS|CUSTOM|PERSON|ORG|CODENAME)_\d+\])/g;
const TOKEN_EXACT_RE =
  /^\[(?:PEM_KEY|API_SECRET|AWS_KEY|JWT|SSN|EIN|CARD|IBAN|EMAIL|PHONE|IPV4|IPV6|ADDRESS|CUSTOM|PERSON|ORG|CODENAME)_\d+\]$/;

function renderHighlightedPayload(text: string): ReactNode {
  if (!text.trim()) {
    return (
      <span className="muted-sm">
        Paste or load a document in Source Document to inspect the masked payload.
      </span>
    );
  }
  const parts = text.split(TOKEN_SPLIT_RE);
  return parts.map((part, idx) =>
    TOKEN_EXACT_RE.test(part) ? (
      <mark key={`${part}-${idx}`} className="pii-token-highlight">
        {part}
      </mark>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
}

export function RedactionDiff({ redaction, semanticPii }: RedactionDiffProps) {
  const [view, setView] = useState<'redacted' | 'vault'>('redacted');
  const [copied, setCopied] = useState(false);

  const activeCategories = CATEGORY_ORDER.filter(
    (cat) => redaction.countsByCategory[cat] > 0
  );
  const vaultEntries = Object.entries(redaction.vault);
  const semanticEntityTotal =
    redaction.countsByCategory.PERSON +
    redaction.countsByCategory.ORG +
    redaction.countsByCategory.CODENAME;

  const handleCopyRedacted = async () => {
    try {
      await navigator.clipboard.writeText(redaction.redactedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="redaction-panel">
      <div className="panel-header-row">
        <div>
          <h3>Local Zero-Leakage PII Vault</h3>
          <p className="muted-sm">
            {redaction.totalMasked} sensitive item(s) masked deterministically in
            your browser before any model prompt is built.
          </p>
        </div>
        <div className="vault-actions-row">
          <div className="tab-group" role="tablist" aria-label="Vault view">
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
              Token Mapping ({vaultEntries.length})
            </button>
          </div>
          <button
            type="button"
            className="btn-inline"
            onClick={handleCopyRedacted}
          >
            {copied ? 'Copied' : 'Copy Safe Text'}
          </button>
        </div>
      </div>

      {semanticPii && semanticPii.status !== 'skipped' && (
        <div
          className={`semantic-pii-strip ${
            semanticPii.status === 'completed'
              ? 'semantic-strip-ok'
              : 'semantic-strip-muted'
          }`}
        >
          <span className="badge badge-emerald mono">
            STAGE 0.5 · {semanticPii.status.toUpperCase()}
          </span>
          <span className="muted-sm">
            {semanticPii.reason ??
              `On-device semantic scan added ${semanticPii.entitiesAdded} token(s).`}
          </span>
          <span className="mono muted-sm">
            PERSON:{redaction.countsByCategory.PERSON} · ORG:
            {redaction.countsByCategory.ORG} · CODENAME:
            {redaction.countsByCategory.CODENAME} ({semanticEntityTotal} total)
          </span>
        </div>
      )}

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
        <div className="redacted-preview mono" role="region" aria-label="Redacted Payload">
          {renderHighlightedPayload(redaction.redactedText)}
        </div>
      ) : (
        <div className="vault-table-wrap">
          {vaultEntries.length === 0 ? (
            <p className="muted-sm vault-empty">
              No PII or secrets detected in current text.
            </p>
          ) : (
            <table className="vault-table mono">
              <thead>
                <tr>
                  <th>Mask Token (Safe for Cloud)</th>
                  <th>Original Value (Browser-Only)</th>
                </tr>
              </thead>
              <tbody>
                {vaultEntries.map(([token, original]) => (
                  <tr key={token}>
                    <td className="token-cell">{token}</td>
                    <td className="original-cell">{original}</td>
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
