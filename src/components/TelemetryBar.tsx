import type {
  AppCheckStatus,
  ChromeNanoAvailability,
  RunTelemetry
} from '../types/analysis';

interface TelemetryBarProps {
  chromeAvailability: ChromeNanoAvailability;
  downloadProgress: number | null;
  isOnline: boolean;
  firebaseConfigured: boolean;
  appCheck: AppCheckStatus;
  triageTelemetry: RunTelemetry | null;
  escalationTelemetry: RunTelemetry | null;
  onWarmUpNano: () => void;
  onRefreshAppCheck: () => void;
}

function getBadgeClass(badge: RunTelemetry['badge']): string {
  switch (badge) {
    case 'ON-DEVICE':
      return 'badge badge-emerald';
    case 'CLOUD FALLBACK':
    case 'CLOUD ESCALATION':
      return 'badge badge-amber';
    case 'SIMULATED ON-DEVICE':
    case 'SIMULATED CLOUD':
      return 'badge badge-cyan';
    default:
      return 'badge badge-slate';
  }
}

export function TelemetryBar({
  chromeAvailability,
  downloadProgress,
  isOnline,
  firebaseConfigured,
  appCheck,
  triageTelemetry,
  escalationTelemetry,
  onWarmUpNano,
  onRefreshAppCheck
}: TelemetryBarProps) {
  const activeTelemetry = escalationTelemetry ?? triageTelemetry;

  return (
    <section className="telemetry-bar" aria-label="Hybrid Inference Telemetry">
      <div className="telemetry-grid">
        <div className="telemetry-cell">
          <span className="telemetry-label">Active Inference Route</span>
          <div className="telemetry-value-row">
            {triageTelemetry ? (
              <span className={getBadgeClass(triageTelemetry.badge)}>
                {triageTelemetry.badge}
              </span>
            ) : (
              <span className="badge badge-slate">READY (IDLE)</span>
            )}
            {escalationTelemetry && (
              <span className={getBadgeClass(escalationTelemetry.badge)}>
                + {escalationTelemetry.badge}
              </span>
            )}
          </div>
          <span className="telemetry-sub">
            {activeTelemetry
              ? `${activeTelemetry.modelName} (${activeTelemetry.requestedMode})`
              : 'InferenceMode.PREFER_ON_DEVICE ready'}
          </span>
        </div>

        <div className="telemetry-cell">
          <span className="telemetry-label">Chrome Gemini Nano</span>
          <div className="telemetry-value-row">
            <span
              className={`status-dot ${
                chromeAvailability === 'available'
                  ? 'dot-green'
                  : chromeAvailability === 'downloadable' ||
                      chromeAvailability === 'downloading'
                    ? 'dot-amber'
                    : 'dot-muted'
              }`}
            />
            <strong className="mono">{chromeAvailability.toUpperCase()}</strong>
            {(chromeAvailability === 'downloadable' ||
              chromeAvailability === 'downloading') && (
              <button
                type="button"
                className="btn-inline"
                onClick={onWarmUpNano}
                disabled={downloadProgress !== null && downloadProgress < 1}
              >
                {downloadProgress !== null
                  ? `Downloading ${Math.round(downloadProgress * 100)}%`
                  : 'Warm Up Nano'}
              </button>
            )}
          </div>
          <span className="telemetry-sub">
            Network: {isOnline ? 'Online' : 'Offline (Air-Gapped)'}
          </span>
        </div>

        <div className="telemetry-cell">
          <span className="telemetry-label">Firebase App Check</span>
          <div className="telemetry-value-row">
            <span
              className={`status-dot ${
                appCheck.tokenVerified
                  ? 'dot-green'
                  : appCheck.initialized
                    ? 'dot-amber'
                    : 'dot-muted'
              }`}
            />
            <strong className="mono">
              {firebaseConfigured
                ? appCheck.tokenVerified
                  ? 'VERIFIED'
                  : appCheck.mode.toUpperCase()
                : 'NOT CONFIGURED'}
            </strong>
            {firebaseConfigured && (
              <button
                type="button"
                className="btn-inline"
                onClick={onRefreshAppCheck}
              >
                Check Token
              </button>
            )}
          </div>
          <span className="telemetry-sub" title={appCheck.note}>
            {appCheck.tokenPreview
              ? `Token ${appCheck.tokenPreview}`
              : appCheck.note}
          </span>
        </div>

        <div className="telemetry-cell">
          <span className="telemetry-label">Latency &amp; Tokens</span>
          <div className="telemetry-value-row mono">
            <strong>
              {triageTelemetry ? `${triageTelemetry.latencyMs}ms` : '-- ms'}
            </strong>
            <span className="divider">/</span>
            <span>
              {triageTelemetry
                ? `${triageTelemetry.totalTokens} tok (${triageTelemetry.tokenCountSource === 'usage_metadata' ? 'exact' : 'est'})`
                : '-- tok'}
            </span>
          </div>
          <span className="telemetry-sub">
            {triageTelemetry
              ? `${triageTelemetry.piiMaskedBeforeInference} PII entity token(s) masked locally`
              : 'Zero raw PII sent to cloud'}
          </span>
        </div>
      </div>

      {triageTelemetry?.fallbackReason && (
        <div className="telemetry-banner">
          <strong>Routing Trace:</strong> {triageTelemetry.fallbackReason}
        </div>
      )}
    </section>
  );
}
