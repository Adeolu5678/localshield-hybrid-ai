import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getInitialRuntimeStatus,
  initializeFirebaseServices,
  type FirebaseServicesHandle
} from '../src/lib/firebaseClient';
import {
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis,
  type ModelFactory
} from '../src/lib/hybridRouter';
import { redactDocument } from '../src/lib/piiRedactor';
import type {
  ChromeNanoAvailability,
  HybridExecutionReport,
  HybridPolicyMode,
  PiiCategory,
  RiskClause
} from '../src/types/analysis';

type SidePanelPolicyChoice =
  | 'prefer_on_device'
  | 'only_on_device'
  | 'hybrid_escalation';

interface ExtractedPagePayload {
  title: string;
  url: string;
  text: string;
  wasTruncated: boolean;
  fromSelection: boolean;
}

function mapPolicyChoice(choice: SidePanelPolicyChoice): {
  policyMode: HybridPolicyMode;
  runCloudEscalation: boolean;
} {
  if (choice === 'only_on_device') {
    return { policyMode: 'only_on_device', runCloudEscalation: false };
  }
  if (choice === 'hybrid_escalation') {
    return { policyMode: 'prefer_in_cloud', runCloudEscalation: true };
  }
  return { policyMode: 'prefer_on_device', runCloudEscalation: false };
}

function resolveRouteBadge(report: HybridExecutionReport): {
  label: 'ON_DEVICE' | 'IN_CLOUD' | 'LOCAL';
  className: string;
} {
  const source =
    report.escalationTelemetry?.inferenceSource ??
    report.triageTelemetry.inferenceSource;

  if (source === 'on_device') {
    return { label: 'ON_DEVICE', className: 'sp-pill-emerald' };
  }
  if (source === 'in_cloud') {
    return { label: 'IN_CLOUD', className: 'sp-pill-sky' };
  }
  return { label: 'LOCAL', className: 'sp-pill-amber' };
}

function severityPillClass(severity: RiskClause['severity']): string {
  if (severity === 'critical') return 'sp-pill-red';
  if (severity === 'high') return 'sp-pill-amber';
  if (severity === 'medium') return 'sp-pill-sky';
  return 'sp-pill-emerald';
}

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (
    /^(?:chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)
  ) {
    return true;
  }
  return /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(
    url
  );
}

function buildCompactBriefMarkdown(
  title: string,
  url: string,
  report: HybridExecutionReport
): string {
  const active = report.escalation ?? report.triage;
  const route = resolveRouteBadge(report);
  const complianceSection =
    active.complianceFlags && active.complianceFlags.length > 0
      ? [
          ``,
          `## Compliance Flags`,
          ...active.complianceFlags.map((flag) => `- ${flag}`)
        ]
      : [];
  const crossClauseSection =
    active.crossClauseFindings && active.crossClauseFindings.length > 0
      ? [
          ``,
          `## Cross-Clause Findings`,
          ...active.crossClauseFindings.map(
            (cf) => `- **${cf.title}**: ${cf.impact}`
          )
        ]
      : [];
  const lines = [
    `# LegalEase Side-Panel Brief`,
    ``,
    `- **Page:** ${title || active.documentType}`,
    url ? `- **URL:** ${url}` : '',
    `- **Risk Score:** ${active.overallRiskScore}/100 (${active.riskPosture})`,
    `- **Route:** ${route.label} (${report.triageTelemetry.modelName})`,
    `- **PII Masked Locally:** ${report.redaction.totalMasked}`,
    ``,
    `## Executive Summary`,
    active.executiveSummary,
    ...complianceSection,
    ...crossClauseSection,
    ``,
    `## Flagged Clauses`,
    ...active.clauses.map(
      (c) =>
        `### [${c.severity.toUpperCase()}] ${c.title}\n- **Risk:** ${c.rationale}\n- **Redline:** ${c.redlineProposal}\n`
    )
  ].filter(Boolean);

  return lines.join('\n');
}

export function SidePanelApp() {
  const [sourceText, setSourceText] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [policyChoice, setPolicyChoice] =
    useState<SidePanelPolicyChoice>('prefer_on_device');
  const [enableSemanticPii, setEnableSemanticPii] = useState(false);
  const [forceSandbox, setForceSandbox] = useState(false);
  const [customTermsInput, setCustomTermsInput] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  const [chromeAvailability, setChromeAvailability] =
    useState<ChromeNanoAvailability>('unsupported');
  const [firebaseHandle, setFirebaseHandle] =
    useState<FirebaseServicesHandle | null>(null);
  const [cloudModelName, setCloudModelName] = useState(
    () => getInitialRuntimeStatus().cloudModel
  );

  const [isScanningTab, setIsScanningTab] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [decisions, setDecisions] = useState<Record<string, 'applied' | 'dismissed'>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<HybridExecutionReport | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      void chrome.storage.local
        .get(['policyChoice', 'customTermsInput'])
        .then((stored) => {
          if (!active) return;
          if (
            stored.policyChoice === 'prefer_on_device' ||
            stored.policyChoice === 'only_on_device' ||
            stored.policyChoice === 'hybrid_escalation'
          ) {
            setPolicyChoice(stored.policyChoice);
          }
          if (typeof stored.customTermsInput === 'string') {
            setCustomTermsInput(stored.customTermsInput);
          }
        })
        .catch(() => {
          // Ignore storage read errors in non-extension preview.
        });
    }
    void probeChromeNanoAvailability().then((status) => {
      if (active) setChromeAvailability(status);
    });
    void initializeFirebaseServices({ skipAppCheck: true }).then((handle) => {
      if (!active) return;
      if (handle) {
        setFirebaseHandle(handle);
        setCloudModelName(handle.status.cloudModel);
      }
    });
    return () => {
      active = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  const modelFactory: ModelFactory | undefined = useMemo(
    () =>
      firebaseHandle
        ? (mode, schemaKey) => firebaseHandle.getHybridModel(mode, schemaKey)
        : undefined,
    [firebaseHandle]
  );

  const customTerms = useMemo(
    () =>
      customTermsInput
        .split(/[\n,]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    [customTermsInput]
  );

  const liveRedaction = useMemo(
    () => redactDocument(sourceText, { customTerms }),
    [sourceText, customTerms]
  );

  const runAuditOnText = async (textToAudit: string) => {
    if (!textToAudit.trim()) {
      setError('No text to audit. Scan an active tab or paste text below.');
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsAnalyzing(true);
    setError(null);
    setNotice(null);

    try {
      const { policyMode, runCloudEscalation } = mapPolicyChoice(policyChoice);
      const executionReport = await runHybridDocumentAnalysis(textToAudit, {
        policyMode,
        runCloudEscalation,
        isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
        chromeNanoAvailability: chromeAvailability,
        useSimulatedSandbox: forceSandbox || !firebaseHandle,
        cloudModelName,
        modelFactory,
        enableSemanticPii,
        customTerms,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setReport(executionReport);
      setExpandedIds({});
      setDecisions({});
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error ? err.message : 'Hybrid analysis failed.'
      );
    } finally {
      if (!controller.signal.aborted) {
        setIsAnalyzing(false);
      }
    }
  };

  const handleScanActiveTab = async () => {
    setError(null);
    setNotice(null);

    if (
      typeof chrome === 'undefined' ||
      !chrome.tabs?.query ||
      !chrome.scripting?.executeScript
    ) {
      setNotice(
        'Chrome tab scripting API is unavailable in this preview. Paste page text below and click Audit Text.'
      );
      return;
    }

    setIsScanningTab(true);
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!activeTab?.id || isRestrictedUrl(activeTab.url)) {
        setPageTitle(activeTab?.title ?? 'Restricted Tab');
        setPageUrl(activeTab?.url ?? '');
        setNotice(
          'Cannot inject into chrome:// or restricted tabs. Paste the Terms or Privacy Policy text below instead.'
        );
        return;
      }

      const results = await chrome.scripting.executeScript<ExtractedPagePayload>({
        target: { tabId: activeTab.id },
        func: () => {
          const maxChars = 40000;
          const selection = (window.getSelection()?.toString() || '').trim();
          const fromSelection = selection.length > 0;
          const rawText = fromSelection
            ? selection
            : (document.body?.innerText || '').trim();
          const normalized = rawText.replace(/\n{3,}/g, '\n\n');
          const wasTruncated = normalized.length > maxChars;
          return {
            title: document.title || 'Untitled Page',
            url: window.location.href,
            text: normalized.slice(0, maxChars),
            wasTruncated,
            fromSelection
          };
        }
      });

      const payload = results[0]?.result;
      if (!payload || !payload.text.trim()) {
        setNotice(
          'No visible text could be extracted from this tab. Paste the clause text below.'
        );
        return;
      }

      setPageTitle(payload.title);
      setPageUrl(payload.url);
      setSourceText(payload.text);
      await runAuditOnText(payload.text);
      if (payload.wasTruncated) {
        setNotice(
          `Extracted ${payload.fromSelection ? 'selected text' : 'page text'} was truncated to 40,000 characters.`
        );
      } else if (payload.fromSelection) {
        setNotice('Audited selected text from the active tab.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/^file:\/\//i.test(pageUrl) || /file:\/\//i.test(msg)) {
        setError(
          'Cannot read local file:// URLs unless "Allow access to file URLs" is enabled in Chrome extension settings. Paste text below instead.'
        );
      } else {
        setError(
          msg
            ? `Could not read active tab (${msg}). Paste text below instead.`
            : 'Could not read active tab. Paste text below instead.'
        );
      }
    } finally {
      setIsScanningTab(false);
    }
  };

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      setError('Clipboard copy was blocked by the browser.');
    }
  };

  const activeAnalysis = report ? (report.escalation ?? report.triage) : null;
  const routeBadge = report ? resolveRouteBadge(report) : null;
  const activeRedaction = report ? report.redaction : liveRedaction;
  const piiEntries = (
    Object.entries(activeRedaction.countsByCategory) as Array<
      [PiiCategory, number]
    >
  ).filter(([, count]) => count > 0);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const setClauseDecision = (id: string, next?: 'applied' | 'dismissed') => {
    setDecisions((prev) => {
      const copy = { ...prev };
      if (!next) {
        delete copy[id];
      } else {
        copy[id] = next;
      }
      return copy;
    });
  };

  return (
    <div className="sp-shell">
      <header className="sp-topbar">
        <div className="sp-brand">
          <img
            src="icons/legalease-logo.jpg"
            alt="LegalEase"
            className="sp-logo"
          />
          <h1 className="sp-title">LegalEase</h1>
        </div>
        <div className="sp-topbar-actions">
          <button
            type="button"
            className="sp-btn-pill"
            disabled={isScanningTab || isAnalyzing}
            onClick={() => void handleScanActiveTab()}
          >
            {isScanningTab
              ? 'Scanning...'
              : isAnalyzing
                ? 'Auditing...'
                : 'Scan Active Tab'}
          </button>
          <button
            type="button"
            className="sp-btn-ghost"
            aria-expanded={showOptions}
            onClick={() => setShowOptions((v) => !v)}
          >
            Options
          </button>
        </div>
      </header>

      {showOptions && (
        <section className="sp-card">
          <label>
            <span className="sp-label">Policy Mode</span>
            <select
              className="sp-select"
              value={policyChoice}
              onChange={(e) => {
                const next = e.target.value as SidePanelPolicyChoice;
                setPolicyChoice(next);
                if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                  void chrome.storage.local
                    .set({ policyChoice: next })
                    .catch(() => {});
                }
              }}
            >
              <option value="prefer_on_device">Prefer On-Device</option>
              <option value="only_on_device">Strict Air-Gap (Nano Only)</option>
              <option value="hybrid_escalation">Hybrid Escalation</option>
            </select>
          </label>

          <label>
            <span className="sp-label">Custom Redaction Terms</span>
            <input
              type="text"
              className="sp-input"
              value={customTermsInput}
              onChange={(e) => {
                const next = e.target.value;
                setCustomTermsInput(next);
                if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                  void chrome.storage.local
                    .set({ customTermsInput: next })
                    .catch(() => {});
                }
              }}
              placeholder="Comma-separated names, orgs, or IDs..."
            />
          </label>

          <label className="sp-checkbox">
            <input
              type="checkbox"
              checked={enableSemanticPii}
              onChange={(e) => setEnableSemanticPii(e.target.checked)}
            />
            <span>Stage 0.5 Semantic PII (On-Device PERSON/ORG scrub)</span>
          </label>

          <label className="sp-checkbox">
            <input
              type="checkbox"
              checked={forceSandbox}
              onChange={(e) => setForceSandbox(e.target.checked)}
            />
            <span>Sandbox Mode (Simulated local heuristic)</span>
          </label>
        </section>
      )}

      <section className="sp-card">
        {pageTitle && (
          <div className="sp-page-meta">
            <strong>{pageTitle}</strong>
            {pageUrl && <span className="sp-page-url mono">{pageUrl}</span>}
          </div>
        )}

        <textarea
          className="sp-textarea mono"
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Click 'Scan Active Tab' above, or paste Terms of Service / Privacy Policy text here..."
        />

        <div className="sp-row">
          <span className="sp-sub mono">
            {sourceText.length.toLocaleString()} chars · Nano:{' '}
            {chromeAvailability}
          </span>
          <button
            type="button"
            className="sp-btn-secondary"
            disabled={isAnalyzing || !sourceText.trim()}
            onClick={() => void runAuditOnText(sourceText)}
          >
            {isAnalyzing ? 'Auditing...' : 'Audit Text'}
          </button>
        </div>

        {notice && <div className="sp-banner-info">{notice}</div>}
        {error && (
          <div className="sp-banner-error" role="alert">
            {error}
          </div>
        )}
      </section>

      {piiEntries.length > 0 && (
        <section className="sp-card">
          <span className="sp-label">Local PII Vault Masked</span>
          <div className="sp-chips mono">
            {piiEntries.map(([category, count]) => (
              <span key={category} className="sp-chip">
                {category}: {count}
              </span>
            ))}
          </div>
        </section>
      )}

      {report && activeAnalysis && routeBadge && (
        <section className="sp-card">
          <div className="sp-score-row">
            <div>
              <span className="sp-label">{activeAnalysis.documentType}</span>
              <div className="sp-score-value">
                {activeAnalysis.overallRiskScore}
                <span className="sp-score-denom">
                  / 100 · {activeAnalysis.riskPosture}
                </span>
              </div>
            </div>
            <div className="sp-row">
              <span className="sp-pill sp-pill-emerald mono">
                Proof of Privacy ({activeRedaction.totalMasked})
              </span>
              <span className={`sp-pill mono ${routeBadge.className}`}>
                {routeBadge.label}
              </span>
            </div>
          </div>

          <p className="sp-clause-body">{activeAnalysis.executiveSummary}</p>

          <div className="sp-row">
            <span className="sp-sub mono">
              {activeAnalysis.clauses.length} flagged issue
              {activeAnalysis.clauses.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="sp-btn-secondary"
              onClick={() =>
                void copyText(
                  'brief',
                  buildCompactBriefMarkdown(pageTitle, pageUrl, report)
                )
              }
            >
              {copiedKey === 'brief' ? 'Copied Brief' : 'Copy Brief'}
            </button>
          </div>
        </section>
      )}

      {report &&
        activeAnalysis &&
        activeAnalysis.clauses.map((clause) => {
          const decision = decisions[clause.id];
          const isExpanded = Boolean(expandedIds[clause.id]);
          return (
            <article
              key={clause.id}
              className={`sp-issue${decision ? ' is-decided' : ''}`}
            >
              <button
                type="button"
                className="sp-issue-trigger"
                aria-expanded={isExpanded}
                onClick={() => toggleExpanded(clause.id)}
              >
                <div className="sp-issue-head">
                  <span
                    className={`sp-pill mono ${severityPillClass(clause.severity)}`}
                  >
                    {clause.severity.toUpperCase()}
                  </span>
                  <span
                    className={`sp-issue-title${decision ? ' is-struck' : ''}`}
                  >
                    {clause.title}
                  </span>
                </div>
                <span className="sp-sub mono">{isExpanded ? '−' : '+'}</span>
              </button>

              <div className="sp-issue-actions">
                {!decision ? (
                  <>
                    <button
                      type="button"
                      className="sp-btn-fix"
                      onClick={() => {
                        setClauseDecision(clause.id, 'applied');
                        void copyText(clause.id, clause.redlineProposal);
                      }}
                    >
                      ✓ Apply Fix
                    </button>
                    <button
                      type="button"
                      className="sp-btn-dismiss"
                      onClick={() => setClauseDecision(clause.id, 'dismissed')}
                    >
                      ✕ Dismiss
                    </button>
                  </>
                ) : (
                  <>
                    <span className="sp-sub mono">
                      {decision === 'applied' ? 'Fix copied' : 'Dismissed'}
                    </span>
                    <button
                      type="button"
                      className="sp-btn-dismiss"
                      onClick={() => setClauseDecision(clause.id)}
                    >
                      Undo
                    </button>
                  </>
                )}
              </div>

              {isExpanded && (
                <>
                  <p className="sp-clause-body">{clause.rationale}</p>
                  <div className="sp-redline-box">
                    <strong>Redline:</strong> {clause.redlineProposal}
                  </div>
                </>
              )}
            </article>
          );
        })}
    </div>
  );
}
