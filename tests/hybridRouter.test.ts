import { describe, expect, it, vi } from 'vitest';
import {
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis,
  type HybridModelRunner
} from '../src/lib/hybridRouter';
import { SAMPLE_DOCUMENTS } from '../src/data/sampleDocuments';

const VALID_JSON_RESPONSE = JSON.stringify({
  documentType: 'SaaS MSA',
  overallRiskScore: 88,
  riskPosture: 'Critical',
  executiveSummary: 'High liability and AI training risks detected.',
  clauses: [
    {
      id: 'c-1',
      title: 'Vendor $100 Liability Cap',
      category: 'Liability',
      severity: 'critical',
      excerpt: 'Vendor liability shall not exceed $100 USD.',
      rationale: 'Leaves customer exposed for vendor outages and breaches.',
      redlineProposal: 'Set mutual 12-month fee cap.'
    }
  ],
  crossClauseFindings: [
    {
      id: 'x-1',
      title: 'Liability Cap + AI Training Compound Risk',
      involvedClauses: ['c-1'],
      impact: 'Vendor trains on customer data without meaningful financial accountability.',
      negotiationMove: 'Add zero-training addendum and carve out confidentiality from cap.'
    }
  ],
  complianceFlags: ['GDPR Art. 33']
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

describe('runHybridDocumentAnalysis', () => {
  it('records ON-DEVICE telemetry and masks PII before inference when Firebase AI Logic runs on-device', async () => {
    const promptsSent: string[] = [];
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async (prompt: string) => {
        promptsSent.push(prompt);
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
      cloudModelName: 'gemini-2.5-flash',
      modelFactory: () => mockModel
    });

    expect(report.triageTelemetry.badge).toBe('ON-DEVICE');
    expect(report.triageTelemetry.inferenceSource).toBe('on_device');
    expect(report.triageTelemetry.tokenCountSource).toBe('estimated');
    expect(report.redaction.totalMasked).toBeGreaterThanOrEqual(6);

    expect(promptsSent[0]).not.toContain('jordan.vance@acmerobotics.io');
    expect(promptsSent[0]).not.toContain('123-45-6789');
    expect(promptsSent[0]).not.toContain('sk-live-9f8a7b6c5d4e3f2a1b0c9d8e');
    expect(promptsSent[0]).toContain('[EMAIL_1]');
    expect(promptsSent[0]).toContain('[SSN_1]');
  });

  it('records CLOUD FALLBACK telemetry with usageMetadata when PREFER_ON_DEVICE falls back to cloud', async () => {
    const promptsSent: string[] = [];
    const mockModel: HybridModelRunner = {
      generateContent: vi.fn(async (prompt: string) => {
        promptsSent.push(prompt);
        return {
          response: {
            text: () => VALID_JSON_RESPONSE,
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
      cloudModelName: 'gemini-2.5-flash',
      modelFactory: () => mockModel
    });

    expect(report.triageTelemetry.badge).toBe('CLOUD FALLBACK');
    expect(report.triageTelemetry.inferenceSource).toBe('in_cloud');
    expect(report.triageTelemetry.totalTokens).toBe(600);
    expect(report.triageTelemetry.tokenCountSource).toBe('usage_metadata');
    expect(report.triageTelemetry.fallbackReason).toContain('unavailable');

    expect(report.escalation).not.toBeNull();
    expect(report.escalationTelemetry?.badge).toBe('CLOUD ESCALATION');
    expect(promptsSent).toHaveLength(2);
    expect(promptsSent[1]).not.toContain('4532-8910-4412-9081');
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
      cloudModelName: 'gemini-2.5-flash',
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
      cloudModelName: 'gemini-2.5-flash',
      modelFactory: () => mockModel
    });

    expect(report.escalation).toBeNull();
    expect(report.escalationBlockedReason).toContain('offline');
  });

  it('runs deterministic sandbox simulation when Firebase env is unconfigured', async () => {
    const report = await runHybridDocumentAnalysis(SAMPLE_DOCUMENTS[0].content, {
      policyMode: 'prefer_on_device',
      runCloudEscalation: true,
      isOnline: true,
      chromeNanoAvailability: 'unsupported',
      useSimulatedSandbox: true,
      cloudModelName: 'gemini-2.5-flash'
    });

    expect(report.triageTelemetry.badge).toBe('SIMULATED ON-DEVICE');
    expect(report.escalationTelemetry?.badge).toBe('SIMULATED CLOUD');
    expect(report.triage.clauses.length).toBeGreaterThanOrEqual(4);
    expect(report.escalation?.crossClauseFindings.length).toBeGreaterThanOrEqual(1);
  });
});
