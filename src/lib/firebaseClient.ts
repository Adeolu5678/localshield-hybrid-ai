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
  type ObjectSchema
} from 'firebase/ai';
import type {
  AppCheckStatus,
  FirebaseRuntimeStatus,
  HybridPolicyMode
} from '../types/analysis';

declare global {
  interface Window {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

export type AppCheckProviderKind = 'recaptcha-enterprise' | 'recaptcha-v3';

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
      cloudModel: env.VITE_FIREBASE_CLOUD_MODEL?.trim() || 'gemini-3-flash-preview',
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
            enum: ['critical', 'high', 'medium', 'low']
          }),
          excerpt: Schema.string(),
          rationale: Schema.string(),
          redlineProposal: Schema.string()
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
    }
  },
  required: ['documentType', 'overallRiskScore', 'riskPosture', 'executiveSummary', 'clauses']
};

export interface FirebaseServicesHandle {
  app: FirebaseApp;
  ai: AI;
  appCheck: AppCheck | null;
  status: FirebaseRuntimeStatus;
  getHybridModel: (mode: HybridPolicyMode) => GenerativeModel;
  refreshAppCheckStatus: () => Promise<AppCheckStatus>;
}

const APP_CHECK_TOKEN_TIMEOUT_MS = 5000;

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

  return Promise.race([getToken(appCheckInstance, false), timeoutPromise]).finally(
    () => {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  );
}

let cachedHandle: FirebaseServicesHandle | null = null;

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

export async function initializeFirebaseServices(): Promise<FirebaseServicesHandle | null> {
  if (cachedHandle) return cachedHandle;

  const { config, missingEnvKeys } = readFirebaseEnvConfig();
  if (missingEnvKeys.length > 0) {
    return null;
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(config.firebaseOptions);

  let appCheck: AppCheck | null = null;
  let appCheckStatus: AppCheckStatus = {
    mode: 'unconfigured',
    initialized: false,
    limitedUseTokens: config.useLimitedUseAppCheckTokens,
    tokenVerified: false,
    note: 'App Check not configured. Set VITE_APPCHECK_RECAPTCHA_SITE_KEY or VITE_APPCHECK_DEBUG_TOKEN.'
  };

  if (typeof window !== 'undefined' && config.appCheckDebugToken) {
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

  const getHybridModel = (mode: HybridPolicyMode): GenerativeModel => {
    const hybridParams: HybridParams = {
      mode: mapPolicyToSdkInferenceMode(mode),
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }]
        },
        promptOptions: {
          responseConstraint: ON_DEVICE_JSON_CONSTRAINT
        }
      },
      inCloudParams: {
        model: config.cloudModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: DOCUMENT_ANALYSIS_SCHEMA
        }
      }
    };
    return getGenerativeModel(ai, hybridParams);
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
    refreshAppCheckStatus
  };

  return cachedHandle;
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
