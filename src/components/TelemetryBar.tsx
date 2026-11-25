import type {
  AppCheckStatus,
  ChromeNanoAvailability,
  CloudDegradationInfo,
  RunTelemetry
} from '../types/analysis';

interface TelemetryBarProps {
  chromeAvailability: ChromeNanoAvailability;
  downloadProgress: number | null;
  isOnline: boolean;
  firebaseConfigured: boolean;
  useSimulatedSandbox: boolean;
  appCheck: AppCheckStatus;
  triageTelemetry: RunTelemetry | null;
  escalationTelemetry: RunTelemetry | null;
  cloudDegradation?: CloudDegradationInfo;
  onWarmUpNano: () => void;
  onRefreshAppCheck: () => void;
  onEnableSandbox: () => void;
}

function getBadgeClass(badge: RunTelemetry['badge']): string {
  switch (badge) {
    case 'ON-DEVICE':
      return 'badge badge-emerald';
    case 'CLOUD FALLBACK':
    case 'CLOUD ESCALATION':
    case 'SIMULATED CLOUD':
      return 'badge badge-sky';
    case 'SIMULATED ON-DEVICE':
      return 'badge badge-emerald';
    case 'LOCAL HEURISTIC':
      return 'badge badge-amber';
    default:
      return 'badge badge-slate';
  }
}

function getAppCheckLabel(
  firebaseConfigured: boolean,
  appCheck: AppCheckStatus
): { text: string; pillClass: string } {
  if (!firebaseConfigured) {
    return { text: 'NOT CONFIGURED', pillClass: 'status-pill pill-muted' };
  }
  if (appCheck.tokenVerified) {
    return { text: 'VERIFIED', pillClass: 'status-pill pill-emerald' };
  }
  if (appCheck.initialized) {
    return {
      text:
        appCheck.mode === 'debug-token'
          ? 'DEBUG ACTIVE'
          : appCheck.mode === 'recaptcha-enterprise'
            ? 'RECAPTCHA ENT READY'
            : 'RECAPTCHA READY',
      pillClass: 'status-pill pill-sky'
    };
  }
  if (appCheck.mode === 'debug-token') {
    return { text: 'SITE KEY MISSING', pillClass: 'status-pill pill-amber' };
  }
  if (appCheck.mode === 'error') {
    return { text: 'INIT ERROR', pillClass: 'status-pill pill-red' };
  }
  return { text: 'UNINITIALIZED', pillClass: 'status-pill pill-amber' };
}

export function TelemetryBar({
  chromeAvailability,
  downloadProgress,
  isOnline,
  firebaseConfigured,
  useSimulatedSandbox,
  appCheck,
  triageTelemetry,
  escalationTelemetry,
  cloudDegradation,
  onWarmUpNano,
  onRefreshAppCheck,
  onEnableSandbox
}: TelemetryBarProps) {
  const activeTelemetry = escalationTelemetry ?? triageTelemetry;
  const appCheckBadge = getAppCheckLabel(firebaseConfigured, appCheck);

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
              <span className="badge badge-slate">READY · IDLE</span>
            )}
            {escalationTelemetry && (
              <span className={getBadgeClass(escalationTelemetry.badge)}>
                + {escalationTelemetry.badge}
              </span>
            )}
          </div>
          <p className="telemetry-sub">
            {activeTelemetry
              ? `${activeTelemetry.modelName} (${activeTelemetry.requestedMode})`
              : useSimulatedSandbox
                ? 'Sandbox Simulation mode active (0 cloud quota spent)'
                : 'InferenceMode.PREFER_ON_DEVICE ready'}
          </p>
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
            <span className="status-pill pill-muted mono">
              {chromeAvailability.toUpperCase()}
            </span>
            <span
              className={`status-pill ${isOnline ? 'pill-sky' : 'pill-amber'}`}
            >
              {isOnline ? 'Online' : 'Offline · Air-Gapped'}
            </span>
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
          <p className="telemetry-sub">
            {chromeAvailability === 'available'
              ? 'On-device Prompt API ready for zero-egress triage.'
              : 'Falls back cleanly to Cloud Gemini or Local Heuristic.'}
          </p>
        </div>

        <div className="telemetry-cell">
          <span className="telemetry-label">Firebase App Check</span>
          <div className="telemetry-value-row">
            <span
              className={`status-dot ${
                appCheck.tokenVerified
                  ? 'dot-green'
                  : appCheck.initialized
                    ? 'dot-sky'
                    : 'dot-amber'
              }`}
            />
            <span className={`${appCheckBadge.pillClass} mono`}>
              {appCheckBadge.text}
            </span>
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
          <p className="telemetry-sub">
            {appCheck.tokenPreview
              ? `Token ${appCheck.tokenPreview} verified`
              : appCheck.note}
            {appCheck.lastCheckedAt && (
              <span className="checked-time mono">
                {' '}
                (checked{' '}
                {new Date(appCheck.lastCheckedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
                )
              </span>
            )}
          </p>
        </div>

        <div className="telemetry-cell">
          <span className="telemetry-label">Latency &amp; Privacy</span>
          <div className="telemetry-value-row mono tabular">
            <strong>
              {triageTelemetry ? `${triageTelemetry.latencyMs}ms` : '-- ms'}
            </strong>
            <span className="divider">/</span>
            <span>
              {triageTelemetry
                ? `${triageTelemetry.totalTokens} tok (${
                    triageTelemetry.tokenCountSource === 'usage_metadata'
                      ? 'exact'
                      : 'est'
                  })`
                : '-- tok'}
            </span>
          </div>
          <p className="telemetry-sub">
            {triageTelemetry
              ? `${triageTelemetry.piiMaskedBeforeInference} PII entity token(s) masked locally`
              : 'Zero raw PII leaves browser'}
          </p>
        </div>
      </div>

      {triageTelemetry?.fallbackReason && (
        <div
          className={`telemetry-banner ${
            cloudDegradation ? 'telemetry-banner-warn' : 'telemetry-banner-sky'
          }`}
        >
          <div className="telemetry-banner-copy">
            <strong>
              {cloudDegradation ? 'Degraded Gracefully:' : 'Routing Trace:'}
            </strong>{' '}
            {triageTelemetry.fallbackReason}
          </div>
          {cloudDegradation && !useSimulatedSandbox && (
            <button
              type="button"
              className="btn-inline btn-inline-accent"
              onClick={onEnableSandbox}
            >
              Switch to Sandbox Mode
            </button>
          )}
        </div>
      )}
    </section>
  );
}
