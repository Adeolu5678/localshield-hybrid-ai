import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions
} from 'firebase/app';
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  type AppCheck
} from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  Schema,
  type AI,
  type GenerativeModel,
  type HybridParams,
  type ObjectSchema,
  type Part
} from 'firebase/ai';
import type {
  AppCheckStatus,
  FirebaseRuntimeStatus,
  HybridPolicyMode,
  InlineAttachment
} from '../types/analysis';

declare global {
  interface Window {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

export type AppCheckProviderKind = 'recaptcha-enterprise' | 'recaptcha-v3';
export type ModelSchemaKey =
  | 'document_analysis'
  | 'semantic_pii'
  | 'negotiation_chat';

export interface FirebaseEnvConfig {
  firebaseOptions: FirebaseOptions;
  cloudModel: string;
  appCheckDebugToken: string;
  appCheckProvider: AppCheckProviderKind;
  recaptchaSiteKey: string;
  useLimitedUseAppCheckTokens: boolean;
}

const REQUIRED_ENV_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID'
] as const;

export function readFirebaseEnvConfig(
  envOverride?: Record<string, string | undefined>
): {
  config: FirebaseEnvConfig;
  missingEnvKeys: string[];
} {
  const env =
    envOverride ??
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ??
    {};
  const missingEnvKeys = REQUIRED_ENV_KEYS.filter(
    (key) => !env[key] || env[key]!.trim().length === 0
  );

  const firebaseOptions: FirebaseOptions = {
    apiKey: env.VITE_FIREBASE_API_KEY?.trim(),
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: env.VITE_FIREBASE_PROJECT_ID?.trim(),
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
    appId: env.VITE_FIREBASE_APP_ID?.trim()
  };

  return {
    config: {
      firebaseOptions,
      cloudModel: env.VITE_FIREBASE_CLOUD_MODEL?.trim() || 'gemini-2.5-flash-lite',
      appCheckDebugToken: env.VITE_APPCHECK_DEBUG_TOKEN?.trim() || '',
      appCheckProvider:
        env.VITE_APPCHECK_PROVIDER?.trim() === 'recaptcha-v3'
          ? 'recaptcha-v3'
          : 'recaptcha-enterprise',
      recaptchaSiteKey: env.VITE_APPCHECK_RECAPTCHA_SITE_KEY?.trim() || '',
      useLimitedUseAppCheckTokens: env.VITE_APPCHECK_LIMITED_USE === 'true'
    },
    missingEnvKeys: [...missingEnvKeys]
  };
}

/**
 * Structured JSON Schema built with the official firebase/ai Schema helper
 * for Cloud Gemini responseSchema enforcement.
 */
export const DOCUMENT_ANALYSIS_SCHEMA: ObjectSchema = Schema.object({
  properties: {
    documentType: Schema.string({
      description: 'Detected document type (e.g., SaaS MSA, Privacy Policy, DPA).'
    }),
    overallRiskScore: Schema.integer({
      description: 'Overall risk score from 0 (safe) to 100 (severe).'
    }),
    riskPosture: Schema.enumString({
      enum: ['Critical', 'Elevated', 'Moderate', 'Low'],
      description: 'Summary risk tier.'
    }),
    executiveSummary: Schema.string({
      description: 'Concise 2-3 sentence executive summary of key risks.'
    }),
    clauses: Schema.array({
      items: Schema.object({
        properties: {
          id: Schema.string(),
          title: Schema.string(),
          category: Schema.string(),
          severity: Schema.enumString({
            enum: ['critical', 'high', 'medium', 'low'],
            description:
              'Calibrated severity: critical (uncapped liability, perpetual IP/AI license, unilateral termination/modification), high (asymmetric indemnity, silent auto-renewal, MFN, >72h breach notice), medium (ambiguous SLA/cure period), low (minor boilerplate).'
          }),
          excerpt: Schema.string({
            description:
              'Short exact verbatim quote copied directly from the document; never paraphrase or fabricate.'
          }),
          rationale: Schema.string({
            description:
              'Structured legal impact: (1) concrete financial/IP/liability exposure, (2) defined-term or cross-clause interaction, (3) worst-case scenario for the reviewing party.'
          }),
          redlineProposal: Schema.string({
            description:
              'Drop-in replacement contract language with mutual caps, notice periods, or explicit carve-outs — not generic advice.'
          })
        }
      })
    }),
    crossClauseFindings: Schema.array({
      items: Schema.object({
        properties: {
          id: Schema.string(),
          title: Schema.string(),
          involvedClauses: Schema.array({ items: Schema.string() }),
          impact: Schema.string(),
          negotiationMove: Schema.string()
        }
      })
    }),
    complianceFlags: Schema.array({
      items: Schema.string()
    })
  }
});

/**
 * Plain JSON Schema object passed to Chrome Prompt API onDeviceParams.promptOptions.responseConstraint.
 */
export const ON_DEVICE_JSON_CONSTRAINT: Record<string, unknown> = {
  type: 'object',
  properties: {
    documentType: { type: 'string' },
    overallRiskScore: { type: 'number' },
    riskPosture: { type: 'string', enum: ['Critical', 'Elevated', 'Moderate', 'Low'] },
    executiveSummary: { type: 'string' },
    clauses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          category: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          excerpt: { type: 'string' },
          rationale: { type: 'string' },
          redlineProposal: { type: 'string' }
        },
        required: ['title', 'category', 'severity', 'excerpt', 'rationale', 'redlineProposal']
      }
    },
    complianceFlags: {
      type: 'array',
      items: { type: 'string' }
    },
    crossClauseFindings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          involvedClauses: { type: 'array', items: { type: 'string' } },
          impact: { type: 'string' },
          negotiationMove: { type: 'string' }
        }
      }
    }
  },
  required: ['documentType', 'overallRiskScore', 'riskPosture', 'executiveSummary', 'clauses']
};

/**
 * Stage 0.5 On-Device Semantic PII extraction schema (person names, organizations, codenames).
 */
export const SEMANTIC_PII_SCHEMA: ObjectSchema = Schema.object({
  properties: {
    entities: Schema.array({
      items: Schema.object({
        properties: {
          value: Schema.string({
            description: 'Exact sensitive entity substring appearing in the text.'
          }),
          category: Schema.enumString({
            enum: ['PERSON', 'ORG', 'CODENAME'],
            description: 'Semantic entity class.'
          })
        }
      })
    })
  }
});

export const SEMANTIC_PII_ON_DEVICE_CONSTRAINT: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          category: { type: 'string', enum: ['PERSON', 'ORG', 'CODENAME'] }
        },
        required: ['value', 'category']
      }
    }
  },
  required: ['entities']
};

/**
 * Builds either a plain text prompt or a multimodal Parts array including
 * inlineData attachments (e.g., scanned contract images or PDF pages).
 */
const SUPPORTED_INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf'
]);

export function buildMultimodalContentParts(
  prompt: string,
  attachments?: InlineAttachment[]
): string | Array<string | Part> {
  if (!attachments || attachments.length === 0) {
    return prompt;
  }
  const parts: Array<string | Part> = [prompt];
  for (const att of attachments) {
    if (!att.mimeType || !att.data) continue;
    if (!SUPPORTED_INLINE_MIME_TYPES.has(att.mimeType.toLowerCase())) continue;
    parts.push({
      type: 'inlineData',
      inlineData: {
        mimeType: att.mimeType,
        data: att.data
      }
    });
  }
  return parts.length === 1 ? prompt : parts;
}

export interface FirebaseServicesHandle {
  app: FirebaseApp;
  ai: AI;
  appCheck: AppCheck | null;
  status: FirebaseRuntimeStatus;
  getHybridModel: (
    mode: HybridPolicyMode,
    schemaKey?: ModelSchemaKey
  ) => GenerativeModel;
  clearModelCache: () => void;
  refreshAppCheckStatus: () => Promise<AppCheckStatus>;
}

const APP_CHECK_TOKEN_TIMEOUT_MS = 8000;

function getAppCheckTokenWithTimeout(
  appCheckInstance: AppCheck,
  timeoutMs = APP_CHECK_TOKEN_TIMEOUT_MS
): Promise<Awaited<ReturnType<typeof getToken>>> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for App Check / reCAPTCHA script.`
        )
      );
    }, timeoutMs);
  });

  const tokenPromise = getToken(appCheckInstance, false);
  tokenPromise.catch(() => {});
  return Promise.race([tokenPromise, timeoutPromise]).finally(
    () => {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  );
}

let cachedHandle: FirebaseServicesHandle | null = null;
let cachedConfigSignature: string | null = null;
const modelCache = new Map<string, GenerativeModel>();

export function resetModelCache(): void {
  modelCache.clear();
}

export function resetFirebaseClientForTests(): void {
  modelCache.clear();
  cachedHandle = null;
  cachedConfigSignature = null;
}

export function mapPolicyToSdkInferenceMode(mode: HybridPolicyMode): InferenceMode {
  switch (mode) {
    case 'prefer_on_device':
      return InferenceMode.PREFER_ON_DEVICE;
    case 'only_on_device':
      return InferenceMode.ONLY_ON_DEVICE;
    case 'prefer_in_cloud':
      return InferenceMode.PREFER_IN_CLOUD;
    case 'only_in_cloud':
      return InferenceMode.ONLY_IN_CLOUD;
  }
}

function buildHybridParams(
  mode: HybridPolicyMode,
  schemaKey: ModelSchemaKey,
  cloudModel: string
): HybridParams {
  if (schemaKey === 'semantic_pii') {
    return {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }]
        },
        promptOptions: {
          responseConstraint: SEMANTIC_PII_ON_DEVICE_CONSTRAINT
        }
      },
      inCloudParams: {
        model: cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SEMANTIC_PII_SCHEMA
        }
      }
    };
  }

  if (schemaKey === 'negotiation_chat') {
    return {
      mode: mapPolicyToSdkInferenceMode(mode),
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }]
        }
      },
      inCloudParams: {
        model: cloudModel,
        systemInstruction:
          'You are LocalShield Clause Negotiator. Help the user draft pragmatic legal counter-proposals and negotiation talking points using ONLY the PII-redacted contract context provided.'
      }
    };
  }

  const sdkMode = mapPolicyToSdkInferenceMode(mode);
  return {
    mode: sdkMode,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      },
      promptOptions: {
        responseConstraint: ON_DEVICE_JSON_CONSTRAINT
      }
    },
    ...(mode === 'only_on_device'
      ? {}
      : {
          inCloudParams: {
            model: cloudModel,
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: DOCUMENT_ANALYSIS_SCHEMA
            }
          }
        })
  };
}

let inFlightInitPromise: Promise<FirebaseServicesHandle | null> | null = null;

export async function initializeFirebaseServices(): Promise<FirebaseServicesHandle | null> {
  const { config, missingEnvKeys } = readFirebaseEnvConfig();
  if (missingEnvKeys.length > 0) {
    return null;
  }

  const configSignature = JSON.stringify({
    firebaseOptions: config.firebaseOptions,
    cloudModel: config.cloudModel,
    appCheckDebugToken: config.appCheckDebugToken,
    appCheckProvider: config.appCheckProvider,
    recaptchaSiteKey: config.recaptchaSiteKey,
    useLimitedUseAppCheckTokens: config.useLimitedUseAppCheckTokens
  });

  if (cachedHandle && cachedConfigSignature === configSignature) {
    return cachedHandle;
  }

  if (inFlightInitPromise && cachedConfigSignature === configSignature) {
    return inFlightInitPromise;
  }

  if (cachedConfigSignature !== configSignature) {
    modelCache.clear();
    cachedHandle = null;
    cachedConfigSignature = configSignature;
  }

  inFlightInitPromise = (async () => {
    try {
      const app = getApps().length > 0 ? getApp() : initializeApp(config.firebaseOptions);

  let appCheck: AppCheck | null = null;
  let appCheckStatus: AppCheckStatus = {
    mode: 'unconfigured',
    initialized: false,
    limitedUseTokens: config.useLimitedUseAppCheckTokens,
    tokenVerified: false,
    note: 'App Check not configured. Set VITE_APPCHECK_RECAPTCHA_SITE_KEY or VITE_APPCHECK_DEBUG_TOKEN.'
  };

  if (typeof window !== 'undefined' && config.appCheckDebugToken && import.meta.env?.DEV) {
    window.FIREBASE_APPCHECK_DEBUG_TOKEN =
      config.appCheckDebugToken === 'true' ? true : config.appCheckDebugToken;
  }

  if (config.recaptchaSiteKey) {
    try {
      const provider =
        config.appCheckProvider === 'recaptcha-v3'
          ? new ReCaptchaV3Provider(config.recaptchaSiteKey)
          : new ReCaptchaEnterpriseProvider(config.recaptchaSiteKey);
      appCheck = initializeAppCheck(app, {
        provider,
        isTokenAutoRefreshEnabled: true
      });
      appCheckStatus = {
        mode: config.appCheckDebugToken ? 'debug-token' : config.appCheckProvider,
        initialized: true,
        limitedUseTokens: config.useLimitedUseAppCheckTokens,
        tokenVerified: false,
        note: config.appCheckDebugToken
          ? 'App Check active with debug token mode enabled.'
          : config.appCheckProvider === 'recaptcha-enterprise'
            ? 'App Check active with reCAPTCHA Enterprise provider.'
            : 'App Check active with reCAPTCHA v3 provider.'
      };
    } catch (err) {
      appCheckStatus = {
        mode: 'error',
        initialized: false,
        limitedUseTokens: config.useLimitedUseAppCheckTokens,
        tokenVerified: false,
        note: err instanceof Error ? err.message : 'App Check initialization error.'
      };
    }
  } else if (config.appCheckDebugToken) {
    appCheckStatus = {
      mode: 'debug-token',
      initialized: false,
      limitedUseTokens: config.useLimitedUseAppCheckTokens,
      tokenVerified: false,
      note: 'Debug token flag is set, but VITE_APPCHECK_RECAPTCHA_SITE_KEY is empty in .env.'
    };
  }

  const ai = getAI(app, {
    backend: new GoogleAIBackend(),
    useLimitedUseAppCheckTokens: config.useLimitedUseAppCheckTokens
  });

  const getHybridModel = (
    mode: HybridPolicyMode,
    schemaKey: ModelSchemaKey = 'document_analysis'
  ): GenerativeModel => {
    const effectiveMode =
      schemaKey === 'semantic_pii' ? 'only_on_device' : mode;
    const cacheKey = `${effectiveMode}::${schemaKey}::${config.cloudModel}`;
    const existing = modelCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const hybridParams = buildHybridParams(
      effectiveMode,
      schemaKey,
      config.cloudModel
    );
    const model = getGenerativeModel(ai, hybridParams);
    modelCache.set(cacheKey, model);
    return model;
  };

  const refreshAppCheckStatus = async (): Promise<AppCheckStatus> => {
    const checkedAt = new Date().toISOString();
    if (!appCheck) {
      appCheckStatus = {
        ...appCheckStatus,
        tokenVerified: false,
        lastCheckedAt: checkedAt,
        note: config.appCheckDebugToken && !config.recaptchaSiteKey
          ? 'No token minted: add VITE_APPCHECK_RECAPTCHA_SITE_KEY in .env to exchange your debug token.'
          : 'No token minted: App Check provider is unconfigured. Set VITE_APPCHECK_RECAPTCHA_SITE_KEY in .env.'
      };
      return appCheckStatus;
    }
    try {
      const tokenRes = await getAppCheckTokenWithTimeout(appCheck);
      appCheckStatus = {
        ...appCheckStatus,
        tokenVerified: Boolean(tokenRes.token),
        tokenPreview: tokenRes.token
          ? `${tokenRes.token.slice(0, 12)}...${tokenRes.token.slice(-6)}`
          : undefined,
        lastCheckedAt: checkedAt,
        note: 'App Check token verified for Firebase AI Logic cloud requests.'
      };
    } catch (err) {
      appCheckStatus = {
        ...appCheckStatus,
        tokenVerified: false,
        lastCheckedAt: checkedAt,
        note:
          err instanceof Error
            ? `App Check token check failed: ${err.message}`
            : 'App Check token check failed.'
      };
    }
    if (cachedHandle) {
      cachedHandle.status.appCheck = appCheckStatus;
    }
    return appCheckStatus;
  };

  cachedHandle = {
    app,
    ai,
    appCheck,
    status: {
      configured: true,
      projectId: config.firebaseOptions.projectId,
      cloudModel: config.cloudModel,
      appCheck: appCheckStatus,
      missingEnvKeys: []
    },
    getHybridModel,
    clearModelCache: resetModelCache,
    refreshAppCheckStatus
  };
  cachedConfigSignature = configSignature;

  return cachedHandle;
    } finally {
      inFlightInitPromise = null;
    }
  })();

  return inFlightInitPromise;
}

/**
 * Pre-initializes the default `prefer_on_device` model instance during browser
 * idle time to eliminate first-click cold-start overhead.
 */
export function warmUpModelCache(
  handle: FirebaseServicesHandle | null | undefined
): boolean {
  if (!handle) {
    return false;
  }
  try {
    handle.getHybridModel('prefer_on_device', 'document_analysis');
    return true;
  } catch {
    return false;
  }
}

export function getInitialRuntimeStatus(
  envOverride?: Record<string, string | undefined>
): FirebaseRuntimeStatus {
  const { config, missingEnvKeys } = readFirebaseEnvConfig(envOverride);
  if (missingEnvKeys.length > 0) {
    return getUnconfiguredRuntimeStatus(envOverride);
  }

  return {
    configured: true,
    projectId: config.firebaseOptions.projectId,
    cloudModel: config.cloudModel,
    appCheck: {
      mode: config.recaptchaSiteKey
        ? config.appCheckDebugToken
          ? 'debug-token'
          : config.appCheckProvider
        : config.appCheckDebugToken
          ? 'debug-token'
          : 'unconfigured',
      initialized: false,
      limitedUseTokens: config.useLimitedUseAppCheckTokens,
      tokenVerified: false,
      note: config.recaptchaSiteKey
        ? 'Initializing Firebase App Check...'
        : 'App Check not configured. Set VITE_APPCHECK_RECAPTCHA_SITE_KEY or VITE_APPCHECK_DEBUG_TOKEN.'
    },
    missingEnvKeys: []
  };
}

export function getUnconfiguredRuntimeStatus(
  envOverride?: Record<string, string | undefined>
): FirebaseRuntimeStatus {
  const { config, missingEnvKeys } = readFirebaseEnvConfig(envOverride);
  return {
    configured: false,
    projectId: config.firebaseOptions.projectId,
    cloudModel: config.cloudModel,
    appCheck: {
      mode: config.appCheckDebugToken ? 'debug-token' : 'unconfigured',
      initialized: false,
      limitedUseTokens: config.useLimitedUseAppCheckTokens,
      tokenVerified: false,
      note: 'Configure .env with Firebase credentials to enable live App Check + cloud Gemini fallback.'
    },
    missingEnvKeys
  };
}
