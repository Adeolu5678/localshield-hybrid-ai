import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTriagePrompt,
  chunkDocumentText,
  classifyCloudError,
  clearHybridAnalysisCache,
  computeHybridDelta,
  createClauseNegotiator,
  extractCuadHints,
  extractDefinedTerms,
  negotiateClauseTurn,
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis,
  type HybridModelRunner
} from '../src/lib/hybridRouter';
import { SAMPLE_DOCUMENTS } from '../src/data/sampleDocuments';
import type { DocumentAnalysisResult, PipelineStage } from '../src/types/analysis';

beforeEach(() => {
  clearHybridAnalysisCache();
});

const VALID_JSON_RESPONSE = JSON.stringify({
  documentType: 'SaaS MSA',
  overallRiskScore: 76,
  riskPosture: 'Critical',
  executiveSummary: 'High liability and AI training risks detected.',
  clauses: [
    {
      id: 'c-1',
      title: 'Vendor $100 Liability Cap',
      category: 'Liability',
      severity: 'high',
      excerpt: 'Vendor liability shall not exceed $100 USD.',
      rationale: 'Leaves customer exposed for vendor outages and breaches.',
      redlineProposal: 'Set mutual 12-month fee cap.'
    }
  ],
  crossClauseFindings: [],
  complianceFlags: ['GDPR Art. 33']
});

const ESCALATED_JSON_RESPONSE = JSON.stringify({
  documentType: 'SaaS MSA',
  overallRiskScore: 91,
  riskPosture: 'Critical',
  executiveSummary:
    'Escalated cloud review upgraded liability cap to critical and found AI training trap.',
  clauses: [
    {
      id: 'c-1',
      title: 'Vendor $100 Liability Cap',
      category: 'Liability',
      severity: 'critical',
      excerpt: 'Vendor liability shall not exceed $100 USD.',
      rationale: 'Leaves customer exposed for vendor outages and breaches.',
      redlineProposal: 'Set mutual 12-month fee cap.'
    },
    {
      id: 'c-2',
      title: 'Perpetual AI Model Training License',
      category: 'Data Privacy & AI',
      severity: 'critical',
      excerpt: 'Perpetual, irrevocable license to train AI models.',
      rationale: 'Permits vendor to absorb confidential customer IP into models.',
      redlineProposal: 'Add Zero Data Retention / No Training addendum.'
    }
  ],
  crossClauseFindings: [
    {
      id: 'x-1',
      title: 'Liability Cap + AI Training Compound Risk',
      involvedClauses: ['c-1', 'c-2'],
      impact:
        'Vendor trains on customer data without meaningful financial accountability.',
      negotiationMove:
        'Add zero-training addendum and carve out confidentiality from cap.'
    }
  ],
  complianceFlags: ['GDPR Art. 33', 'GDPR Art. 5']
});

describe('probeChromeNanoAvailability', () => {
  it('returns unsupported when LanguageModel global is absent', async () => {
    expect(await probeChromeNanoAvailability({})).toBe('unsupported');
  });

  it('returns exact Chrome LanguageModel availability state when present', async () => {
    const fakeGlobal = {
      LanguageModel: {
        availability: vi.fn().mockResolvedValue('available')
      }
    };
    expect(await probeChromeNanoAvailability(fakeGlobal)).toBe('available');
  });
});

describe('chunkDocumentText', () => {
  it('keeps short documents in a single chunk without truncation', () => {
    const res = chunkDocumentText(SAMPLE_DOCUMENTS[0].content, 10000);
    expect(res.chunkCount).toBe(1);
    expect(res.wasChunked).toBe(false);
    expect(res.wasTruncated).toBe(false);
    expect(res.estimatedTokens).toBeGreaterThan(0);
  });

  it('splits long multi-section contracts along section boundaries and tracks truncation', () => {
    const longContract = [
      '1. DEFINITIONS\n' + 'Confidential information means all data. '.repeat(20),
      '2. DATA RIGHTS\n' + 'Vendor may process customer records. '.repeat(20),
      '3. LIABILITY\n' + 'Aggregate liability is capped at $100. '.repeat(20),
      '4. TERMINATION\n' + 'Auto-renews unless 90 days notice given. '.repeat(20)
    ].join('\n\n');

    const res = chunkDocumentText(longContract, 900, 3);
    expect(res.wasChunked).toBe(true);
    expect(res.chunkCount).toBe(3);
    expect(res.wasTruncated).toBe(true);
    expect(res.chunks[0]).toContain('1. DEFINITIONS');
  });
});

describe('runHybridDocumentAnalysis', () => {
  it('records ON-DEVICE telemetry and masks PII before inference when Firebase AI Logic runs on-device', async () => {
    const promptsSent: string[] = [];
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async (prompt) => {
        promptsSent.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        return {
          response: {
            text: () => VALID_JSON_RESPONSE,
            inferenceSource: 'on_device' as const
          }
        };
      })
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: false,
      isOnline: false,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: () => mockModel
    });

    expect(report.triageTelemetry.badge).toBe('ON-DEVICE');
    expect(report.triageTelemetry.inferenceSource).toBe('on_device');
    expect(report.triageTelemetry.tokenCountSource).toBe('estimated');
    expect(report.redaction.totalMasked).toBeGreaterThanOrEqual(6);

    expect(promptsSent[0]).not.toContain('jordan.vance@acmerobotics.io');
    expect(promptsSent[0]).not.toContain('123-45-6789');
    expect(promptsSent[0]).not.toContain('4532-8910-4412-9089');
    expect(promptsSent[0]).not.toContain('sk-live-9f8a7b6c5d4e3f2a1b0c9d8e');
    expect(promptsSent[0]).not.toContain('Suite 400');
    expect(promptsSent[0]).toContain('[EMAIL_1]');
    expect(promptsSent[0]).toContain('[SSN_1]');
    expect(promptsSent[0]).toContain('[CARD_1]');
    expect(promptsSent[0]).toContain('[ADDRESS_1]');
  });

  it('deduplicates redundant Stage 2 Cloud call when Stage 1 already executed in Cloud', async () => {
    const promptsSent: string[] = [];
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async (prompt) => {
        promptsSent.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        return {
          response: {
            text: () => ESCALATED_JSON_RESPONSE,
            inferenceSource: 'in_cloud' as const,
            usageMetadata: {
              promptTokenCount: 410,
              candidatesTokenCount: 190,
              totalTokenCount: 600
            }
          }
        };
      })
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: true,
      isOnline: true,
      chromeNanoAvailability: 'unavailable',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: () => mockModel
    });

    expect(report.triageTelemetry.badge).toBe('CLOUD FALLBACK');
    expect(report.triageTelemetry.inferenceSource).toBe('in_cloud');
    expect(report.triageTelemetry.totalTokens).toBe(600);
    expect(report.triageTelemetry.tokenCountSource).toBe('usage_metadata');
    expect(report.triageTelemetry.deduplicated).toBe(true);
    expect(report.triageTelemetry.fallbackReason).toContain('unavailable');

    // Only 1 Cloud call fired — no redundant duplicate Stage 2 Cloud call
    expect(promptsSent).toHaveLength(1);
    expect(report.escalation).toBeNull();
    expect(report.escalationTelemetry).toBeNull();
    expect(report.escalationBlockedReason).toContain('deduplicated');
    expect(report.notes.some((n) => n.includes('deduplicated'))).toBe(true);
  });

  it('runs Stage 0.5 semantic PII scrubbing strictly on-device before Stage 2 Cloud Escalation and computes HybridDelta', async () => {
    const factoryCalls: Array<{ mode: string; schemaKey?: string }> = [];
    const cloudPrompts: string[] = [];

    const semanticModel: HybridModelRunner = {
      generateContent: vi.fn(async () => ({
        response: {
          text: () =>
            JSON.stringify({
              entities: [
                { value: 'Acme Robotics Inc.', category: 'ORG' }
              ]
            }),
          inferenceSource: 'on_device' as const
        }
      }))
    };

    const onDeviceTriageModel: HybridModelRunner = {
      countTokens: vi.fn(async () => ({ totalTokens: 320 })),
      generateContent: vi.fn(async () => ({
        response: {
          text: () => VALID_JSON_RESPONSE,
          inferenceSource: 'on_device' as const
        }
      }))
    };

    const cloudEscalationModel: HybridModelRunner = {
      generateContent: vi.fn(async (prompt) => {
        cloudPrompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        return {
          response: {
            text: () => ESCALATED_JSON_RESPONSE,
            inferenceSource: 'in_cloud' as const,
            usageMetadata: {
              promptTokenCount: 500,
              candidatesTokenCount: 250,
              totalTokenCount: 750
            }
          }
        };
      })
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: true,
      enableSemanticPii: true,
      isOnline: true,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: (mode, schemaKey) => {
        factoryCalls.push({ mode, schemaKey });
        if (schemaKey === 'semantic_pii') return semanticModel;
        if (mode === 'only_in_cloud') return cloudEscalationModel;
        return onDeviceTriageModel;
      }
    });

    expect(factoryCalls[0]).toEqual({
      mode: 'only_on_device',
      schemaKey: 'semantic_pii'
    });
    expect(report.semanticPii?.status).toBe('completed');
    expect(report.semanticPii?.entitiesAdded).toBe(1);
    expect(report.redaction.countsByCategory.ORG).toBe(1);
    expect(cloudPrompts).toHaveLength(1);
    expect(cloudPrompts[0]).not.toContain('Acme Robotics Inc.');
    expect(cloudPrompts[0]).toContain('[ORG_1]');
    expect(report.chunkInfo?.tokenProbeSource).toBe('estimated');
    expect(report.chunkInfo?.estimatedTokens).toBeGreaterThan(0);

    // Verify Stage 1 vs Stage 2 delta calculation
    expect(report.delta.newClausesCount).toBe(1);
    expect(report.delta.upgradedSeverityCount).toBe(1);
    expect(report.delta.newCrossClauseCount).toBe(1);
    expect(report.delta.riskScoreDelta).toBe(15);
    expect(report.delta.combinedTokens).toBe(
      report.triageTelemetry.totalTokens +
        (report.escalationTelemetry?.totalTokens ?? 0)
    );
  });

  it('gracefully records unavailable semantic PII when Gemini Nano is not available', async () => {
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async () => ({
        response: {
          text: () => VALID_JSON_RESPONSE,
          inferenceSource: 'in_cloud' as const
        }
      }))
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: false,
      enableSemanticPii: true,
      isOnline: true,
      chromeNanoAvailability: 'unsupported',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: () => mockModel
    });

    expect(report.semanticPii?.status).toBe('unavailable');
    expect(report.semanticPii?.entitiesAdded).toBe(0);
    expect(report.triage.clauses.length).toBeGreaterThanOrEqual(1);
  });

  it('uses generateContentStream when available, emits progress callbacks, and honors AbortSignal', async () => {
    const chunksReceived: Array<{ chunk: string; stage: PipelineStage }> = [];
    const stagesSeen: PipelineStage[] = [];

    const streamingModel: HybridModelRunner = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(async () => {
        async function* gen() {
          yield { text: () => '{"documentType":' };
          yield { text: () => '"SaaS MSA"}' };
        }
        return {
          stream: gen(),
          response: Promise.resolve({
            text: () => VALID_JSON_RESPONSE,
            inferenceSource: 'on_device' as const
          })
        };
      })
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: false,
      isOnline: true,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: () => streamingModel,
      onStreamChunk: (chunk, stage) => chunksReceived.push({ chunk, stage }),
      onStageChange: (stage) => stagesSeen.push(stage)
    });

    expect(report.triageTelemetry.streamed).toBe(true);
    expect(streamingModel.generateContent).not.toHaveBeenCalled();
    expect(chunksReceived).toHaveLength(2);
    expect(stagesSeen).toEqual(['pii_redaction', 'triage', 'complete']);

    // Verify AbortSignal stops execution cleanly
    const controller = new AbortController();
    controller.abort();
    await expect(
      runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
        policyMode: 'prefer_on_device',
        runCloudEscalation: false,
        isOnline: true,
        chromeNanoAvailability: 'available',
        useSimulatedSandbox: false,
        cloudModelName: 'gemini-3-flash-preview',
        modelFactory: () => streamingModel,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes inlineAttachments as multimodal inlineData parts to the model', async () => {
    let receivedRequest: unknown;
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async (req) => {
        receivedRequest = req;
        return {
          response: {
            text: () => VALID_JSON_RESPONSE,
            inferenceSource: 'on_device' as const
          }
        };
      })
    };

    await runHybridDocumentAnalysis('Scanned contract header', {
      policyMode: 'prefer_on_device',
      runCloudEscalation: false,
      isOnline: true,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      inlineAttachments: [
        { mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'scan.png' }
      ],
      modelFactory: () => mockModel
    });

    expect(Array.isArray(receivedRequest)).toBe(true);
    const parts = receivedRequest as Array<unknown>;
    expect(parts[1]).toEqual({
      type: 'inlineData',
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    });
  });

  it('blocks Stage 2 cloud escalation cleanly under ONLY_ON_DEVICE air-gapped mode', async () => {
    const factoryCalls: string[] = [];
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async () => ({
        response: {
          text: () => VALID_JSON_RESPONSE,
          inferenceSource: 'on_device' as const
        }
      }))
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'only_on_device',
      runCloudEscalation: true,
      isOnline: true,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: (mode) => {
        factoryCalls.push(mode);
        return mockModel;
      }
    });

    expect(factoryCalls).toEqual(['only_on_device']);
    expect(report.escalation).toBeNull();
    expect(report.escalationTelemetry).toBeNull();
    expect(report.escalationBlockedReason).toContain('ONLY_ON_DEVICE');
  });

  it('skips Stage 2 cloud escalation when browser is offline', async () => {
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async () => ({
        response: {
          text: () => VALID_JSON_RESPONSE,
          inferenceSource: 'on_device' as const
        }
      }))
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: true,
      isOnline: false,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: () => mockModel
    });

    expect(report.escalation).toBeNull();
    expect(report.escalationBlockedReason).toContain('offline');
  });

  it('honestly labels Sandbox mode as SIMULATED CLOUD when Nano is unsupported and SIMULATED ON-DEVICE when available', async () => {
    const unsupportedReport = await runHybridDocumentAnalysis(
      SAMPLE_DOCUMENTS[0].content,
      {
        policyMode: 'prefer_on_device',
        runCloudEscalation: true,
        isOnline: true,
        chromeNanoAvailability: 'unsupported',
        useSimulatedSandbox: true,
        cloudModelName: 'gemini-3-flash-preview'
      }
    );

    expect(unsupportedReport.triageTelemetry.badge).toBe('SIMULATED CLOUD');
    expect(unsupportedReport.triageTelemetry.fallbackReason).toContain(
      'unsupported'
    );
    expect(unsupportedReport.triageTelemetry.deduplicated).toBe(true);
    expect(unsupportedReport.escalationTelemetry).toBeNull();

    const availableReport = await runHybridDocumentAnalysis(
      SAMPLE_DOCUMENTS[0].content,
      {
        policyMode: 'prefer_on_device',
        runCloudEscalation: true,
        isOnline: true,
        chromeNanoAvailability: 'available',
        useSimulatedSandbox: true,
        cloudModelName: 'gemini-3-flash-preview'
      }
    );

    expect(availableReport.triageTelemetry.badge).toBe('SIMULATED ON-DEVICE');
    expect(availableReport.escalationTelemetry?.badge).toBe('SIMULATED CLOUD');
    expect(availableReport.triage.clauses.length).toBeGreaterThanOrEqual(4);
    expect(
      availableReport.escalation?.crossClauseFindings.length
    ).toBeGreaterThanOrEqual(1);
  });

  it('degrades gracefully when Stage 1 and Stage 2 fail with 401 Firebase App Check error', async () => {
    const failingModel: HybridModelRunner = {
      generateContent: vi.fn(async () => {
        throw new Error(
          'AI/fetch-error: Error fetching from https://firebasevertexai.googleapis.com: [401] Firebase App Check token is invalid.'
        );
      })
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: true,
      isOnline: true,
      chromeNanoAvailability: 'unsupported',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: () => failingModel
    });

    expect(report.triageTelemetry.badge).toBe('LOCAL HEURISTIC');
    expect(report.triageTelemetry.inferenceSource).toBe('local_heuristic');
    expect(report.triageTelemetry.fallbackReason).toContain('401 Firebase App Check');
    expect(report.triage.clauses.length).toBeGreaterThanOrEqual(4);
    expect(report.triage.crossClauseFindings.length).toBeGreaterThanOrEqual(1);
    expect(report.cloudDegradation?.kind).toBe('app_check_401');
    expect(report.escalationBlockedReason).toContain('401 Firebase App Check');
  });

  it('preserves on-device Stage 1 result and falls back locally when Stage 2 cloud escalation throws 401', async () => {
    const onDeviceModel: HybridModelRunner = {
      generateContent: vi.fn(async () => ({
        response: {
          text: () => VALID_JSON_RESPONSE,
          inferenceSource: 'on_device' as const
        }
      }))
    };
    const failingCloudModel: HybridModelRunner = {
      generateContent: vi.fn(async () => {
        throw new Error('401 Firebase App Check token is invalid.');
      })
    };

    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: true,
      isOnline: true,
      chromeNanoAvailability: 'available',
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-3-flash-preview',
      modelFactory: (mode) =>
        mode === 'only_in_cloud' ? failingCloudModel : onDeviceModel
    });

    expect(report.triageTelemetry.badge).toBe('ON-DEVICE');
    expect(report.escalationTelemetry?.badge).toBe('LOCAL HEURISTIC');
    expect(report.escalation?.crossClauseFindings.length).toBeGreaterThanOrEqual(1);
    expect(report.cloudDegradation?.kind).toBe('app_check_401');
    expect(report.cloudDegradation?.stage).toBe('escalation');
  });

  it('classifies App Check 401 and network errors clearly', () => {
    const appCheckErr = classifyCloudError(
      new Error('AI/fetch-error: 401 Firebase App Check token is invalid'),
      'triage'
    );
    expect(appCheckErr.kind).toBe('app_check_401');
    expect(appCheckErr.actionHint).toContain('VITE_APPCHECK_RECAPTCHA_SITE_KEY');

    const netErr = classifyCloudError(
      new Error('AI/fetch-error: Failed to fetch'),
      'escalation'
    );
    expect(netErr.kind).toBe('network_or_api');
  });

  it('computes HybridDelta accurately across clauses, severities, cross-clauses, and risk score', () => {
    const triage: DocumentAnalysisResult = JSON.parse(VALID_JSON_RESPONSE);
    const escalation: DocumentAnalysisResult = JSON.parse(ESCALATED_JSON_RESPONSE);
    const delta = computeHybridDelta(
      triage,
      escalation,
      {
        stage: 'triage',
        badge: 'ON-DEVICE',
        requestedMode: 'prefer_on_device',
        inferenceSource: 'on_device',
        modelName: 'Gemini Nano',
        latencyMs: 120,
        promptTokens: 200,
        candidateTokens: 100,
        totalTokens: 300,
        tokenCountSource: 'estimated',
        piiMaskedBeforeInference: 4,
        timestamp: new Date().toISOString()
      },
      {
        stage: 'escalation',
        badge: 'CLOUD ESCALATION',
        requestedMode: 'only_in_cloud',
        inferenceSource: 'in_cloud',
        modelName: 'gemini-3-flash-preview',
        latencyMs: 450,
        promptTokens: 500,
        candidateTokens: 250,
        totalTokens: 750,
        tokenCountSource: 'usage_metadata',
        piiMaskedBeforeInference: 4,
        timestamp: new Date().toISOString()
      },
      { status: 'completed', entitiesAdded: 2, latencyMs: 80 }
    );

    expect(delta).toEqual({
      newClausesCount: 1,
      upgradedSeverityCount: 1,
      newCrossClauseCount: 1,
      riskScoreDelta: 15,
      totalLatencyMs: 650,
      combinedTokens: 1050
    });
  });
});

describe('createClauseNegotiator & negotiateClauseTurn', () => {
  const sampleClause = {
    id: 'c-1',
    title: 'Vendor $100 Liability Cap',
    category: 'Liability',
    severity: 'critical' as const,
    excerpt: 'Vendor liability shall not exceed $100 USD.',
    rationale: 'Asymmetric financial exposure.',
    redlineProposal: 'Set mutual 12-month fee cap.'
  };

  it('runs multi-turn streaming negotiation via startChat using PREFER_ON_DEVICE online and ONLY_ON_DEVICE offline', async () => {
    const factoryCalls: Array<{ mode: string; schemaKey?: string }> = [];
    const streamedChunks: string[] = [];

    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(),
      startChat: vi.fn(() => ({
        sendMessage: vi.fn(),
        sendMessageStream: vi.fn(async (msg) => {
          async function* gen() {
            yield { text: () => 'Counter-proposal: ' };
            yield { text: () => `12-month mutual cap for "${String(msg)}"` };
          }
          return {
            stream: gen(),
            response: Promise.resolve({
              text: () => `Counter-proposal: 12-month mutual cap for "${String(msg)}"`,
              inferenceSource: 'on_device' as const
            })
          };
        })
      }))
    };

    const negotiator = createClauseNegotiator({
      clause: sampleClause,
      redactedDocumentContext: 'Contract with [ORG_1] and [EMAIL_1].',
      isOnline: true,
      chromeNanoAvailability: 'available',
      modelFactory: (mode, schemaKey) => {
        factoryCalls.push({ mode, schemaKey });
        return mockModel;
      }
    });

    expect(negotiator.effectiveMode).toBe('prefer_on_device');

    const reply = await negotiator.sendMessage('Make it softer for a startup vendor', {
      onStreamChunk: (chunk) => streamedChunks.push(chunk)
    });

    expect(factoryCalls).toEqual([
      { mode: 'prefer_on_device', schemaKey: 'negotiation_chat' }
    ]);
    expect(reply.inferenceSource).toBe('on_device');
    expect(reply.streamed).toBe(true);
    expect(streamedChunks).toHaveLength(2);
    expect(negotiator.getHistory()).toHaveLength(2);

    // Offline forces ONLY_ON_DEVICE
    const offlineNegotiator = createClauseNegotiator({
      clause: sampleClause,
      redactedDocumentContext: 'Redacted text',
      isOnline: false,
      chromeNanoAvailability: 'available',
      modelFactory: () => mockModel
    });
    expect(offlineNegotiator.effectiveMode).toBe('only_on_device');
  });

  it('falls back cleanly in sandbox mode via negotiateClauseTurn', async () => {
    const reply = await negotiateClauseTurn({
      clause: sampleClause,
      redactedDocumentContext: 'Redacted context',
      isOnline: false,
      chromeNanoAvailability: 'unsupported',
      useSimulatedSandbox: true,
      userMessage: 'Give me a firm enterprise redline'
    });

    expect(reply.role).toBe('model');
    expect(reply.inferenceSource).toBe('simulated');
    expect(reply.text).toContain('Set mutual 12-month fee cap.');
  });
});

describe('hybridRouter pure engine improvements', () => {
  it('adds sliding-window overlap and [DEFINED_TERMS: ...] to chunks 2..N', () => {
    const doc = [
      '1. DEFINITIONS\n"Customer Data" means all electronic data submitted by Customer. Acme Corp (the "Vendor") provides the platform. ' +
        'A'.repeat(450) +
        ' boundaryTailMarker.',
      '2. LICENSE\nVendor may process Customer Data under this Agreement. ' + 'B'.repeat(450)
    ].join('\n\n');

    const terms = extractDefinedTerms(doc);
    expect(terms).toContain('Customer Data');
    expect(terms).toContain('Vendor');

    const chunked = chunkDocumentText(doc, 600, 4);
    expect(chunked.chunkCount).toBe(2);
    expect(chunked.chunks[0]).not.toContain('[DEFINED_TERMS:');
    expect(chunked.chunks[1]).toContain('[DEFINED_TERMS: Customer Data, Vendor]');
    expect(chunked.chunks[1]).toContain('boundaryTailMarker.');
  });

  it('caches deterministic hybrid analysis reports and respects bypassCache', async () => {
    clearHybridAnalysisCache();
    const generateContentStream = vi.fn().mockResolvedValue({
      stream: (async function* () {
        yield { text: () => VALID_JSON_RESPONSE };
      })(),
      response: Promise.resolve({
        text: () => VALID_JSON_RESPONSE,
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
      })
    });
    const mockFactory = vi.fn().mockReturnValue({
      generateContent: vi.fn(),
      generateContentStream
    } satisfies HybridModelRunner);

    const baseOptions = {
      policyMode: 'prefer_on_device' as const,
      runCloudEscalation: false,
      isOnline: false,
      chromeNanoAvailability: 'available' as const,
      useSimulatedSandbox: false,
      cloudModelName: 'gemini-2.5-flash',
      modelFactory: mockFactory
    };

    const first = await runHybridDocumentAnalysis(
      'Vendor liability shall not exceed $100 USD.',
      baseOptions
    );
    expect(first.notes.some((n) => n.includes('cached: true'))).toBe(false);
    expect(generateContentStream).toHaveBeenCalledTimes(1);

    const second = await runHybridDocumentAnalysis(
      'Vendor liability shall not exceed $100 USD.',
      baseOptions
    );
    expect(second.notes.some((n) => n.includes('cached: true'))).toBe(true);
    expect(generateContentStream).toHaveBeenCalledTimes(1);

    const bypassed = await runHybridDocumentAnalysis(
      'Vendor liability shall not exceed $100 USD.',
      { ...baseOptions, bypassCache: true }
    );
    expect(bypassed.notes.some((n) => n.includes('cached: true'))).toBe(false);
    expect(generateContentStream).toHaveBeenCalledTimes(2);
  });

  it('extracts CUAD high-risk hints and injects [CUAD_HINTS: ...] into buildTriagePrompt', () => {
    const text =
      'Customer shall hold harmless Vendor. This evergreen agreement shall auto-renew with mandatory arbitration and a class action waiver.';
    const hints = extractCuadHints(text);
    expect(hints).toEqual(
      expect.arrayContaining(['hold harmless', 'evergreen', 'auto-renew', 'arbitration', 'class action'])
    );

    const prompt = buildTriagePrompt(text);
    expect(prompt).toContain('[CUAD_HINTS: hold harmless, auto-renew, evergreen, arbitration, class action]');
  });

  it('createClauseNegotiator falls back to local_heuristic when offline and Nano is unavailable', async () => {
    const negotiator = createClauseNegotiator({
      clause: {
        id: 'c1',
        title: 'Liability Cap',
        category: 'Liability',
        severity: 'high',
        excerpt: 'Liability capped at $100.',
        rationale: 'Too low.',
        redlineProposal: 'Cap at 12 months fees.'
      },
      redactedDocumentContext: 'Liability capped at $100.',
      isOnline: false,
      chromeNanoAvailability: 'unavailable',
      useSimulatedSandbox: false
    });

    const reply = await negotiator.sendMessage('How should we counter this?');
    expect(reply.inferenceSource).toBe('local_heuristic');
    expect(reply.text).toContain('Liability Cap');
  });
});
