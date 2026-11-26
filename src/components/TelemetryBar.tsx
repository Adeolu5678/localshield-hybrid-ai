import { useState } from 'react';
import type {
  AppCheckStatus,
  ChromeNanoAvailability,
  CloudDegradationInfo,
  RunTelemetry,
  SemanticPiiReport
} from '../types/analysis';

interface TelemetryBarProps {
  chromeAvailability: ChromeNanoAvailability;
  downloadProgress: number | null;
  isReprobingNano?: boolean;
  isOnline: boolean;
  firebaseConfigured: boolean;
  useSimulatedSandbox: boolean;
  appCheck: AppCheckStatus;
  triageTelemetry: RunTelemetry | null;
  escalationTelemetry: RunTelemetry | null;
  semanticPii?: SemanticPiiReport;
  cloudDegradation?: CloudDegradationInfo;
  onWarmUpNano: () => void;
  onReprobeNano: () => void;
  onRefreshAppCheck: () => void;
  onEnableSandbox: () => void;
}

const CHROME_NANO_FLAGS = [
  {
    id: 'opt-guide',
    flag: 'chrome://flags/#optimization-guide-on-device-model',
    setting: 'Enabled BypassPerfRequirement'
  },
  {
    id: 'prompt-api',
    flag: 'chrome://flags/#prompt-api-for-gemini-nano',
    setting: 'Enabled'
  }
] as const;

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
  isReprobingNano = false,
  isOnline,
  firebaseConfigured,
  useSimulatedSandbox,
  appCheck,
  triageTelemetry,
  escalationTelemetry,
  semanticPii,
  cloudDegradation,
  onWarmUpNano,
  onReprobeNano,
  onRefreshAppCheck,
  onEnableSandbox
}: TelemetryBarProps) {
  const [nanoDrawerOpen, setNanoDrawerOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const activeTelemetry = escalationTelemetry ?? triageTelemetry;
  const appCheckBadge = getAppCheckLabel(firebaseConfigured, appCheck);
  const showNanoSetupControls =
    chromeAvailability === 'unsupported' ||
    chromeAvailability === 'unavailable';

  const hasBothStages = Boolean(triageTelemetry && escalationTelemetry);
  const combinedLatencyMs =
    (semanticPii?.latencyMs ?? 0) +
    (triageTelemetry?.latencyMs ?? 0) +
    (escalationTelemetry?.latencyMs ?? 0);
  const combinedTokens =
    (triageTelemetry?.totalTokens ?? 0) +
    (escalationTelemetry?.totalTokens ?? 0);

  const tokenSourceLabel = (() => {
    if (!triageTelemetry) return '';
    if (!escalationTelemetry) {
      return triageTelemetry.tokenCountSource === 'usage_metadata'
        ? 'exact'
        : 'est';
    }
    if (
      triageTelemetry.tokenCountSource === 'usage_metadata' &&
      escalationTelemetry.tokenCountSource === 'usage_metadata'
    ) {
      return 'exact';
    }
    if (
      triageTelemetry.tokenCountSource === 'estimated' &&
      escalationTelemetry.tokenCountSource === 'estimated'
    ) {
      return 'est';
    }
    return 'mixed';
  })();

  const formatLatency = (ms: number): string =>
    ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

  const combinedBreakdownTooltip =
    triageTelemetry && escalationTelemetry
      ? `Stage 1 (${triageTelemetry.badge}): ${formatLatency(triageTelemetry.latencyMs)} / ${triageTelemetry.totalTokens} tok · Stage 2 (${escalationTelemetry.badge}): ${formatLatency(escalationTelemetry.latencyMs)} / ${escalationTelemetry.totalTokens} tok`
      : undefined;

  const handleCopyFlag = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1600);
    } catch {
      // Clipboard blocked in restricted context; ignore silently.
    }
  };

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
            {showNanoSetupControls && (
              <>
                <button
                  type="button"
                  className={`btn-inline ${
                    nanoDrawerOpen ? 'btn-inline-emerald' : 'btn-inline-accent'
                  }`}
                  aria-expanded={nanoDrawerOpen}
                  onClick={() => setNanoDrawerOpen((prev) => !prev)}
                >
                  {nanoDrawerOpen ? 'Hide Setup Guide' : 'Enable Gemini Nano'}
                </button>
                <button
                  type="button"
                  className="btn-inline"
                  onClick={onReprobeNano}
                  disabled={isReprobingNano}
                >
                  {isReprobingNano ? 'Probing...' : 'Re-probe Nano'}
                </button>
              </>
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
          <div
            className="telemetry-value-row mono tabular"
            title={combinedBreakdownTooltip}
          >
            {triageTelemetry ? (
              <>
                <strong>{formatLatency(combinedLatencyMs)}</strong>
                <span className="divider">/</span>
                <span>{`${combinedTokens} tok (${tokenSourceLabel})`}</span>
              </>
            ) : (
              <span className="muted-sm">Ready · Run a scan to measure</span>
            )}
          </div>
          {hasBothStages && triageTelemetry && escalationTelemetry && (
            <p className="telemetry-breakdown mono tabular">
              S1 {formatLatency(triageTelemetry.latencyMs)} ({triageTelemetry.totalTokens}t)
              {' + '}S2 {formatLatency(escalationTelemetry.latencyMs)} (
              {escalationTelemetry.totalTokens}t)
            </p>
          )}
          <p className="telemetry-sub">
            {triageTelemetry
              ? `${triageTelemetry.piiMaskedBeforeInference} PII entity token(s) masked locally`
              : 'Zero raw PII leaves browser'}
            {semanticPii && semanticPii.status !== 'skipped'
              ? ` · Stage 0.5 ${semanticPii.status} (+${semanticPii.entitiesAdded})`
              : ''}
          </p>
        </div>
      </div>

      {showNanoSetupControls && nanoDrawerOpen && (
        <div
          className="nano-setup-drawer"
          role="region"
          aria-label="Chrome Gemini Nano 30-second setup guide"
        >
          <div className="nano-setup-head">
            <div>
              <strong>Enable On-Device Chrome Gemini Nano (30s Setup)</strong>
              <p className="muted-sm">
                Paste each flag into Chrome 138+ (Desktop), relaunch Chrome,
                then click <strong>Re-probe Nano</strong> without reloading.
              </p>
            </div>
            <button
              type="button"
              className="btn-inline"
              onClick={onReprobeNano}
              disabled={isReprobingNano}
            >
              {isReprobingNano ? 'Probing...' : 'Re-probe Nano'}
            </button>
          </div>
          <div className="nano-flags-list">
            {CHROME_NANO_FLAGS.map((item) => (
              <div key={item.id} className="nano-flag-row">
                <div className="nano-flag-info">
                  <code className="mono">{item.flag}</code>
                  <span className="nano-flag-setting">
                    Set to <strong>{item.setting}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-inline"
                  onClick={() => void handleCopyFlag(item.id, item.flag)}
                >
                  {copiedKey === item.id ? 'Copied' : 'Copy Flag'}
                </button>
              </div>
            ))}
            <div className="nano-flag-row nano-flag-note">
              <div className="nano-flag-info">
                <code className="mono">chrome://components</code>
                <span className="nano-flag-setting">
                  Verify <strong>Optimization Guide On Device Model</strong> is
                  downloaded (click &ldquo;Check for update&rdquo; if version is{' '}
                  <code className="mono">0.0.0.0</code>).
                </span>
              </div>
              <button
                type="button"
                className="btn-inline"
                onClick={() =>
                  void handleCopyFlag('components', 'chrome://components')
                }
              >
                {copiedKey === 'components' ? 'Copied' : 'Copy URL'}
              </button>
            </div>
          </div>
        </div>
      )}

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
