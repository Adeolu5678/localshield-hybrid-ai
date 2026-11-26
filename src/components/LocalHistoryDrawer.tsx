import type { ScanHistoryRecord } from '../lib/scanHistory';

interface LocalHistoryDrawerProps {
  isOpen: boolean;
  records: ScanHistoryRecord[];
  onClose: () => void;
  onSelectRecord: (record: ScanHistoryRecord) => void;
  onDeleteRecord: (id: string) => void;
  onClearAll: () => void;
}

function formatSavedTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function LocalHistoryDrawer({
  isOpen,
  records,
  onClose,
  onSelectRecord,
  onDeleteRecord,
  onClearAll
}: LocalHistoryDrawerProps) {
  if (!isOpen) return null;

  return (
    <div
      className="drawer-backdrop no-print"
      role="dialog"
      aria-modal="true"
      aria-label="Local Scan History"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="drawer-panel history-drawer-panel">
        <div className="drawer-header">
          <div>
            <span className="telemetry-label">
              IndexedDB Local Vault (PII-Redacted Only)
            </span>
            <h3>Local Scan History ({records.length})</h3>
          </div>
          <button
            type="button"
            className="btn-inline"
            onClick={onClose}
            aria-label="Close local history drawer"
          >
            Close
          </button>
        </div>

        <p className="history-privacy-note">
          Saved strictly on this device in <code>localshield-history-v1</code>.
          Only redacted text and risk briefs are stored — raw PII is never
          persisted.
        </p>

        {records.length === 0 ? (
          <div className="history-empty-state">
            <strong>No local scans saved yet</strong>
            <p className="muted-sm">
              Completed analyses are automatically stored here for offline
              review and reload.
            </p>
          </div>
        ) : (
          <>
            <div className="history-toolbar">
              <span className="muted-sm mono">
                Showing {records.length} newest (cap 25)
              </span>
              <button
                type="button"
                className="btn-danger-outline btn-xs"
                onClick={() => {
                  if (
                    window.confirm(
                      'Clear all saved local scan history? This cannot be undone.'
                    )
                  ) {
                    onClearAll();
                  }
                }}
              >
                Clear All History
              </button>
            </div>

            <div className="history-list">
              {records.map((record) => (
                <article key={record.id} className="history-item">
                  <div className="history-item-head">
                    <div className="history-item-title-wrap">
                      <strong className="history-item-title">
                        {record.title}
                      </strong>
                      <span className="muted-sm mono">
                        {formatSavedTimestamp(record.savedAt)}
                      </span>
                    </div>
                    <span
                      className={`history-score-pill score-${record.riskLabel.toLowerCase()} mono`}
                    >
                      {record.riskScore}/100 · {record.riskLabel}
                    </span>
                  </div>

                  <div className="history-meta-row mono">
                    <span className="history-meta-chip">
                      {record.routeLabel}
                    </span>
                    <span className="history-meta-chip">
                      {record.piiCount} PII masked
                    </span>
                    <span className="history-meta-chip">
                      {record.clauseCount} clauses
                    </span>
                  </div>

                  {record.reportSummary && (
                    <p className="history-summary-preview">
                      {record.reportSummary}
                    </p>
                  )}

                  <div className="history-item-actions">
                    <button
                      type="button"
                      className="btn-inline btn-inline-accent"
                      onClick={() => onSelectRecord(record)}
                    >
                      Load Brief
                    </button>
                    <button
                      type="button"
                      className="btn-inline"
                      onClick={() => onDeleteRecord(record.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
