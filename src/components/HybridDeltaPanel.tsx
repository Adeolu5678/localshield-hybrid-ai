import type {
  ClauseSeverity,
  DocumentAnalysisResult,
  HybridDelta,
  RiskClause,
  RunTelemetry
} from '../types/analysis';

export type AnalysisViewMode = 'merged' | 'triage' | 'escalation';

export interface ClauseDeltaBadge {
  kind: 'new' | 'upgraded';
  previousSeverity?: ClauseSeverity;
}

const SEVERITY_RANK: Record<ClauseSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

/**
 * Computes per-clause origin badges comparing Stage 1 (On-Device) vs Stage 2 (Cloud)
 * so judges can see which clauses were newly discovered or upgraded in Cloud.
 */
export function buildClauseDeltaMap(
  triage: DocumentAnalysisResult,
  escalation: DocumentAnalysisResult | null
): Record<string, ClauseDeltaBadge> {
  if (!escalation) return {};

  const triageById = new Map<string, RiskClause>();
  const triageByTitle = new Map<string, RiskClause>();
  for (const clause of triage.clauses) {
    triageById.set(clause.id.toLowerCase(), clause);
    triageByTitle.set(clause.title.toLowerCase().trim(), clause);
  }

  const badges: Record<string, ClauseDeltaBadge> = {};
  for (const escClause of escalation.clauses) {
    const matched =
      triageById.get(escClause.id.toLowerCase()) ??
      triageByTitle.get(escClause.title.toLowerCase().trim());

    if (!matched) {
      badges[escClause.id] = { kind: 'new' };
    } else if (SEVERITY_RANK[escClause.severity] > SEVERITY_RANK[matched.severity]) {
      badges[escClause.id] = {
        kind: 'upgraded',
        previousSeverity: matched.severity
      };
    }
  }

  return badges;
}

interface HybridDeltaPanelProps {
  delta: HybridDelta;
  triageTelemetry: RunTelemetry;
  escalationTelemetry: RunTelemetry | null;
  hasEscalation: boolean;
  viewMode: AnalysisViewMode;
  onViewModeChange: (mode: AnalysisViewMode) => void;
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function HybridDeltaPanel({
  delta,
  triageTelemetry,
  escalationTelemetry,
  hasEscalation,
  viewMode,
  onViewModeChange
}: HybridDeltaPanelProps) {
  const scoreShiftLabel =
    delta.riskScoreDelta > 0
      ? `+${delta.riskScoreDelta}`
      : `${delta.riskScoreDelta}`;

  return (
    <section
      className="panel-card delta-panel"
      aria-label="Stage 1 vs Stage 2 Hybrid Delta Comparison"
    >
      <div className="delta-header">
        <div>
          <span className="telemetry-label">Hybrid AI Value Delta</span>
          <h3>Stage 1 (On-Device) vs. Stage 2 (Cloud Synthesis)</h3>
        </div>

        {hasEscalation && (
          <div
            className="tab-group"
            role="tablist"
            aria-label="Analysis stage view"
            onKeyDown={(event) => {
              const order: Array<'merged' | 'triage' | 'escalation'> = [
                'merged',
                'triage',
                'escalation'
              ];
              const idx = order.indexOf(viewMode);
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                onViewModeChange(order[(idx + 1) % order.length]);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                onViewModeChange(order[(idx - 1 + order.length) % order.length]);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'merged'}
              className={`tab-btn ${viewMode === 'merged' ? 'active' : ''}`}
              onClick={() => onViewModeChange('merged')}
            >
              Merged / Escalated
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'triage'}
              className={`tab-btn ${viewMode === 'triage' ? 'active' : ''}`}
              onClick={() => onViewModeChange('triage')}
            >
              Stage 1 ({triageTelemetry.badge})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'escalation'}
              className={`tab-btn ${viewMode === 'escalation' ? 'active' : ''}`}
              onClick={() => onViewModeChange('escalation')}
              title="Inspect Stage 2 Cloud Escalation output"
            >
              Stage 2 ({escalationTelemetry ? escalationTelemetry.badge : 'N/A'})
            </button>
          </div>
        )}
      </div>

      <div className="delta-metrics-grid mono tabular">
        <div className="delta-metric">
          <span className="delta-metric-value emerald-text">
            +{delta.newClausesCount}
          </span>
          <span className="delta-metric-label">New Clauses</span>
        </div>
        <div className="delta-metric">
          <span className="delta-metric-value amber-text">
            +{delta.upgradedSeverityCount}
          </span>
          <span className="delta-metric-label">Severity Upgrades</span>
        </div>
        <div className="delta-metric">
          <span className="delta-metric-value sky-text">
            +{delta.newCrossClauseCount}
          </span>
          <span className="delta-metric-label">Cross-Clause Findings</span>
        </div>
        <div className="delta-metric">
          <span
            className={`delta-metric-value ${
              delta.riskScoreDelta > 0
                ? 'red-text'
                : delta.riskScoreDelta < 0
                  ? 'emerald-text'
                  : ''
            }`}
          >
            {scoreShiftLabel}
          </span>
          <span className="delta-metric-label">Risk Score Shift</span>
        </div>
        <div className="delta-metric">
          <span className="delta-metric-value">{formatLatency(delta.totalLatencyMs)}</span>
          <span className="delta-metric-label">Combined Latency</span>
        </div>
        <div className="delta-metric">
          <span className="delta-metric-value">
            {delta.combinedTokens.toLocaleString()}
          </span>
          <span className="delta-metric-label">Combined Tokens</span>
        </div>
      </div>
    </section>
  );
}
