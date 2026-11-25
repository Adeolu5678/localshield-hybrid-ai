import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { ClauseCard } from './components/ClauseCard';
import { RedactionDiff } from './components/RedactionDiff';
import { TelemetryBar } from './components/TelemetryBar';
import { SAMPLE_DOCUMENTS } from './data/sampleDocuments';
import {
  getUnconfiguredRuntimeStatus,
  initializeFirebaseServices,
  type FirebaseServicesHandle
} from './lib/firebaseClient';
import {
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis
} from './lib/hybridRouter';
import { estimateTokenCount, redactSensitiveData } from './lib/piiRedactor';
import type {
  ChromeNanoAvailability,
  FirebaseRuntimeStatus,
  HybridExecutionReport,
  HybridPolicyMode
} from './types/analysis';

function formatBriefMarkdown(report: HybridExecutionReport): string {
  const analysis = report.escalation ?? report.triage;
  const lines = [
    `# LocalShield HybridDoc Brief`,
    ``,
    `- **Document Type:** ${analysis.documentType}`,
    `- **Risk Score:** ${analysis.overallRiskScore}/100 (${analysis.riskPosture})`,
    `- **Stage 1 Route:** ${report.triageTelemetry.badge} (${report.triageTelemetry.modelName})`,
    `- **PII Masked Locally:** ${report.redaction.totalMasked}`,
    report.escalationTelemetry
      ? `- **Stage 2 Escalation:** ${report.escalationTelemetry.badge} (${report.escalationTelemetry.modelName})`
      : `- **Stage 2 Escalation:** ${report.escalationBlockedReason ?? 'Not requested'}`,
    ``,
    `## Executive Summary`,
    analysis.executiveSummary,
    ``,
    `## Flagged Risk Clauses`,
    ...analysis.clauses.map(
      (c) =>
        `### [${c.severity.toUpperCase()}] ${c.title} (${c.category})\n> ${c.excerpt}\n\n- **Risk:** ${c.rationale}\n- **Redline:** ${c.redlineProposal}\n`
    )
  ];

  if (analysis.crossClauseFindings.length > 0) {
    lines.push(`## Cross-Clause Synthesis`);
    for (const f of analysis.crossClauseFindings) {
      lines.push(
        `### ${f.title}\n- **Involved:** ${f.involvedClauses.join(', ')}\n- **Impact:** ${f.impact}\n- **Negotiation Move:** ${f.negotiationMove}\n`
      );
    }
  }
  return lines.join('\n');
}

export function App() {
  const [documentText, setDocumentText] = useState(SAMPLE_DOCUMENTS[0].content);
  const [selectedSampleId, setSelectedSampleId] = useState(SAMPLE_DOCUMENTS[0].id);
  const [leftTab, setLeftTab] = useState<'source' | 'vault'>('source');
  const [policyMode, setPolicyMode] =
    useState<HybridPolicyMode>('prefer_on_device');
  const [runCloudEscalation, setRunCloudEscalation] = useState(true);
  const [useSimulatedSandbox, setUseSimulatedSandbox] = useState(false);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [chromeAvailability, setChromeAvailability] =
    useState<ChromeNanoAvailability>('unsupported');
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const [firebaseHandle, setFirebaseHandle] =
    useState<FirebaseServicesHandle | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<FirebaseRuntimeStatus>(() =>
    getUnconfiguredRuntimeStatus()
  );

  const [report, setReport] = useState<HybridExecutionReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportCopied, setExportCopied] = useState(false);

  const liveRedaction = useMemo(
    () => redactSensitiveData(documentText),
    [documentText]
  );

  const estimatedDocTokens = useMemo(
    () => estimateTokenCount(liveRedaction.redactedText),
    [liveRedaction.redactedText]
  );

  useEffect(() => {
    let active = true;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    void probeChromeNanoAvailability().then((status) => {
      if (active) setChromeAvailability(status);
    });

    void initializeFirebaseServices().then((handle) => {
      if (!active) return;
      if (handle) {
        setFirebaseHandle(handle);
        setRuntimeStatus(handle.status);
      } else {
        setUseSimulatedSandbox(true);
      }
    });

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleSampleSelect = (id: string) => {
    const sample = SAMPLE_DOCUMENTS.find((d) => d.id === id);
    if (!sample) return;
    setSelectedSampleId(sample.id);
    setDocumentText(sample.content);
    setReport(null);
    setErrorMessage(null);
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSelectedSampleId('custom');
    setDocumentText(text);
    setReport(null);
    setErrorMessage(null);
  };

  const handleWarmUpNano = async () => {
    if (!firebaseHandle) return;
    setErrorMessage(null);
    setDownloadProgress(0);
    try {
      const model = firebaseHandle.getHybridModel('prefer_on_device');
      await model.initializeDeviceModel((progress) => {
        setDownloadProgress(progress);
      });
      const updated = await probeChromeNanoAvailability();
      setChromeAvailability(updated);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Failed to initialize on-device Gemini Nano: ${err.message}`
          : 'Failed to initialize on-device Gemini Nano.'
      );
    } finally {
      setDownloadProgress(null);
    }
  };

  const handleRefreshAppCheck = async () => {
    if (!firebaseHandle) return;
    const updatedAppCheck = await firebaseHandle.refreshAppCheckStatus();
    setRuntimeStatus((prev) => ({
      ...prev,
      appCheck: updatedAppCheck
    }));
  };

  const runAnalysis = async (forceSandboxOverride?: boolean) => {
    if (!documentText.trim()) {
      setErrorMessage('Paste or upload a contract, policy, or technical document first.');
      return;
    }
    const effectiveSandbox =
      typeof forceSandboxOverride === 'boolean'
        ? forceSandboxOverride
        : !firebaseHandle || useSimulatedSandbox;

    setIsAnalyzing(true);
    setErrorMessage(null);

    try {
      const executionReport = await runHybridDocumentAnalysis(documentText, {
        policyMode,
        runCloudEscalation,
        isOnline,
        chromeNanoAvailability: chromeAvailability,
        useSimulatedSandbox: effectiveSandbox,
        cloudModelName: runtimeStatus.cloudModel,
        modelFactory: firebaseHandle
          ? (mode) => firebaseHandle.getHybridModel(mode)
          : undefined
      });
      setReport(executionReport);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Hybrid document analysis failed.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleEnableSandboxAndRerun = () => {
    setUseSimulatedSandbox(true);
    void runAnalysis(true);
  };

  const handleExportBrief = async () => {
    if (!report) return;
    const md = formatBriefMarkdown(report);
    try {
      await navigator.clipboard.writeText(md);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 1800);
    } catch {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'LocalShield Risk Brief.md';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const activeAnalysis = report?.escalation ?? report?.triage ?? null;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            LS
          </div>
          <div className="brand-copy">
            <div className="brand-title-row">
              <h1>LocalShield</h1>
              <span className="brand-divider" aria-hidden="true">/</span>
              <span className="brand-product">HybridDoc Brief</span>
            </div>
            <p className="subtitle">
              Zero-Leakage Contract &amp; Policy Intelligence via Firebase AI Logic + Gemini Nano
            </p>
          </div>
        </div>
        <div className="top-actions">
          <span
            className={`env-pill ${
              useSimulatedSandbox
                ? 'env-sandbox'
                : runtimeStatus.configured
                  ? 'env-live'
                  : 'env-sandbox'
            }`}
          >
            {useSimulatedSandbox
              ? 'Sandbox Mode (Dry-Run)'
              : runtimeStatus.configured
                ? `Firebase: ${runtimeStatus.projectId}`
                : 'Sandbox Mode (.env unconfigured)'}
          </span>
        </div>
      </header>

      <TelemetryBar
        chromeAvailability={chromeAvailability}
        downloadProgress={downloadProgress}
        isOnline={isOnline}
        firebaseConfigured={runtimeStatus.configured}
        useSimulatedSandbox={useSimulatedSandbox}
        appCheck={runtimeStatus.appCheck}
        triageTelemetry={report?.triageTelemetry ?? null}
        escalationTelemetry={report?.escalationTelemetry ?? null}
        cloudDegradation={report?.cloudDegradation}
        onWarmUpNano={handleWarmUpNano}
        onRefreshAppCheck={handleRefreshAppCheck}
        onEnableSandbox={handleEnableSandboxAndRerun}
      />

      <main className={`workbench ${activeAnalysis ? 'workbench-active' : 'workbench-idle'}`}>
        <section className="pane pane-left">
          <div className="panel-card left-console-card">
            <div className="console-tabs-bar" role="tablist" aria-label="Document workspace">
              <button
                type="button"
                role="tab"
                aria-selected={leftTab === 'source'}
                className={`console-tab ${leftTab === 'source' ? 'active' : ''}`}
                onClick={() => setLeftTab('source')}
              >
                <span>1. Source Document</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={leftTab === 'vault'}
                className={`console-tab ${leftTab === 'vault' ? 'active' : ''}`}
                onClick={() => setLeftTab('vault')}
              >
                <span>2. PII Redacted Vault</span>
                <span className="tab-count-pill mono">
                  {liveRedaction.totalMasked} masked
                </span>
              </button>
            </div>

            {leftTab === 'source' ? (
              <div className="console-tab-body">
                <div className="panel-header-row">
                  <div className="doc-stats mono">
                    <span>{documentText.length.toLocaleString()} chars</span>
                    <span className="dot-sep" aria-hidden="true">·</span>
                    <span>~{estimatedDocTokens} tok</span>
                    <span className="dot-sep" aria-hidden="true">·</span>
                    <span className="emerald-text">
                      {liveRedaction.totalMasked} PII masked
                    </span>
                  </div>
                  <label className="upload-btn">
                    Load .txt / .md
                    <input
                      type="file"
                      accept=".txt,.md,.policy,.contract"
                      onChange={handleFileUpload}
                      hidden
                    />
                  </label>
                </div>

                <div className="sample-pills">
                  {SAMPLE_DOCUMENTS.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className={`sample-pill ${
                        selectedSampleId === doc.id ? 'active' : ''
                      }`}
                      onClick={() => handleSampleSelect(doc.id)}
                    >
                      <span className="pill-tag">{doc.tag}</span>
                      <span>{doc.label}</span>
                    </button>
                  ))}
                </div>

                <textarea
                  className="doc-textarea mono"
                  rows={11}
                  value={documentText}
                  onChange={(e) => {
                    setDocumentText(e.target.value);
                    setSelectedSampleId('custom');
                  }}
                  placeholder="Paste a contract, privacy policy, SLA, or NDA here..."
                />

                <div className="controls-grid">
                  <label className="control-field">
                    <span>Firebase AI Logic InferenceMode</span>
                    <select
                      value={policyMode}
                      onChange={(e) =>
                        setPolicyMode(e.target.value as HybridPolicyMode)
                      }
                    >
                      <option value="prefer_on_device">
                        PREFER_ON_DEVICE (Nano first, Cloud fallback)
                      </option>
                      <option value="only_on_device">
                        ONLY_ON_DEVICE (Strict Air-Gapped Vault)
                      </option>
                      <option value="prefer_in_cloud">
                        PREFER_IN_CLOUD (Cloud first, Nano fallback)
                      </option>
                      <option value="only_in_cloud">
                        ONLY_IN_CLOUD (App Check Protected Cloud)
                      </option>
                    </select>
                  </label>

                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={runCloudEscalation}
                      disabled={policyMode === 'only_on_device'}
                      onChange={(e) => setRunCloudEscalation(e.target.checked)}
                    />
                    <span>
                      Stage 2: Escalate <strong>PII-redacted</strong> brief to Cloud
                      Gemini for cross-clause synthesis
                    </span>
                  </label>

                  {runtimeStatus.configured && (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={useSimulatedSandbox}
                        onChange={(e) => setUseSimulatedSandbox(e.target.checked)}
                      />
                      <span>
                        Force Local Sandbox Simulation (dry-run without spending cloud
                        quota)
                      </span>
                    </label>
                  )}
                </div>

                {errorMessage && (
                  <div className="error-banner" role="alert">
                    {errorMessage}
                  </div>
                )}

                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void runAnalysis()}
                  disabled={isAnalyzing}
                >
                  {isAnalyzing
                    ? 'Running Hybrid Pipeline...'
                    : 'Analyze Document with Hybrid AI'}
                </button>
              </div>
            ) : (
              <div className="console-tab-body">
                <RedactionDiff redaction={liveRedaction} />
              </div>
            )}
          </div>
        </section>

        <section className="pane pane-right">
          {!activeAnalysis ? (
            <div className="empty-state panel-card">
              <div className="empty-header">
                <span className="status-pill pill-emerald">READY FOR TRIAGE</span>
                <h2>Zero-Leakage Hybrid Intelligence Console</h2>
                <p>
                  LocalShield masks emails, tax IDs, cards, IBANs, IPs, addresses,
                  and API secrets <strong>100% locally</strong> before running{' '}
                  <code>InferenceMode.PREFER_ON_DEVICE</code> via Firebase AI Logic.
                </p>
              </div>

              <div className="pipeline-steps">
                <div className="pipeline-step">
                  <span className="step-num mono">00</span>
                  <div>
                    <strong>Deterministic Local PII Vault</strong>
                    <p>
                      {liveRedaction.totalMasked} sensitive entity token(s) currently
                      masked in-browser. Raw values never leave this tab.
                    </p>
                  </div>
                </div>
                <div className="pipeline-step">
                  <span className="step-num mono">01</span>
                  <div>
                    <strong>Stage 1 · On-Device Triage / Graceful Fallback</strong>
                    <p>
                      Runs Gemini Nano when available, falling back seamlessly to
                      Cloud Gemini or Local Heuristic without blocking the brief.
                    </p>
                  </div>
                </div>
                <div className="pipeline-step">
                  <span className="step-num mono">02</span>
                  <div>
                    <strong>Stage 2 · Redacted Cloud Escalation</strong>
                    <p>
                      Cross-clause contradiction detection and negotiation moves
                      guarded by Firebase App Check and air-gap policy locks.
                    </p>
                  </div>
                </div>
              </div>

              <div className="empty-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setLeftTab('vault')}
                >
                  Inspect Redacted Vault ({liveRedaction.totalMasked})
                </button>
                <button
                  type="button"
                  className="btn-primary btn-compact"
                  onClick={() => void runAnalysis()}
                  disabled={isAnalyzing}
                >
                  {isAnalyzing ? 'Analyzing...' : 'Run Hybrid Analysis'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="panel-card summary-card">
                <div className="summary-top">
                  <div className="summary-main">
                    <span className="telemetry-label">
                      {activeAnalysis.documentType}
                    </span>
                    <h2>Risk Posture: {activeAnalysis.riskPosture}</h2>
                    <p className="summary-text">
                      {activeAnalysis.executiveSummary}
                    </p>
                  </div>
                  <div
                    className={`score-ring score-${activeAnalysis.riskPosture.toLowerCase()}`}
                  >
                    <span className="score-num tabular">
                      {activeAnalysis.overallRiskScore}
                    </span>
                    <span className="score-den">/ 100</span>
                  </div>
                </div>

                {activeAnalysis.complianceFlags.length > 0 && (
                  <div className="compliance-row">
                    {activeAnalysis.complianceFlags.map((flag) => (
                      <span key={flag} className="compliance-pill">
                        {flag}
                      </span>
                    ))}
                  </div>
                )}

                {report?.escalationBlockedReason && (
                  <div
                    className={`info-banner ${
                      report.cloudDegradation ? 'info-banner-warn' : ''
                    }`}
                  >
                    <div>
                      <strong>
                        {report.cloudDegradation
                          ? 'Cloud Escalation Guard (Degraded Locally):'
                          : 'Stage 2 Cloud Escalation Guard:'}
                      </strong>{' '}
                      {report.escalationBlockedReason}
                    </div>
                    {report.cloudDegradation && !useSimulatedSandbox && (
                      <button
                        type="button"
                        className="btn-inline btn-inline-accent"
                        onClick={handleEnableSandboxAndRerun}
                      >
                        Run in Sandbox Simulation
                      </button>
                    )}
                  </div>
                )}

                <div className="summary-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleExportBrief}
                  >
                    {exportCopied
                      ? 'Copied Markdown Brief'
                      : 'Copy / Export Brief (.md)'}
                  </button>
                </div>
              </div>

              {activeAnalysis.crossClauseFindings.length > 0 && (
                <div className="panel-card">
                  <h3>Cross-Clause Compound Findings (Stage 2 Synthesis)</h3>
                  <div className="cross-list">
                    {activeAnalysis.crossClauseFindings.map((finding) => (
                      <div key={finding.id} className="cross-card">
                        <div className="cross-head">
                          <strong>{finding.title}</strong>
                          <span className="mono muted-sm">
                            {finding.involvedClauses.join(' + ')}
                          </span>
                        </div>
                        <p>{finding.impact}</p>
                        <p className="negotiation-line">
                          <strong>Negotiation Move:</strong>{' '}
                          {finding.negotiationMove}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="clauses-stack">
                {activeAnalysis.clauses.map((clause) => (
                  <ClauseCard key={clause.id} clause={clause} />
                ))}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
