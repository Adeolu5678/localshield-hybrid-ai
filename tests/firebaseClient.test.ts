import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApp = { name: '[DEFAULT]' };
const mockAi = { app: mockApp };
const mockAppCheck = { app: mockApp };

const getTokenMock = vi.fn();
const initializeAppCheckMock = vi.fn(() => mockAppCheck);

vi.mock('firebase/app', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => mockApp),
  initializeApp: vi.fn(() => mockApp)
}));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: initializeAppCheckMock,
  getToken: getTokenMock,
  ReCaptchaEnterpriseProvider: vi.fn((siteKey: string) => ({ siteKey })),
  ReCaptchaV3Provider: vi.fn((siteKey: string) => ({ siteKey }))
}));

vi.mock('firebase/ai', () => ({
  getAI: vi.fn(() => mockAi),
  getGenerativeModel: vi.fn(() => ({})),
  GoogleAIBackend: vi.fn(),
  InferenceMode: {
    PREFER_ON_DEVICE: 'prefer_on_device',
    ONLY_ON_DEVICE: 'only_on_device',
    PREFER_IN_CLOUD: 'prefer_in_cloud',
    ONLY_IN_CLOUD: 'only_in_cloud'
  },
  Schema: {
    object: vi.fn((x) => x),
    string: vi.fn((x) => x),
    integer: vi.fn((x) => x),
    enumString: vi.fn((x) => x),
    array: vi.fn((x) => x)
  }
}));

function stubValidFirebaseEnv() {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'AIzaTestKey');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'localshield-hybrid-ai-5678');
  vi.stubEnv('VITE_FIREBASE_APP_ID', '1:123456:web:abcdef');
  vi.stubEnv('VITE_FIREBASE_CLOUD_MODEL', 'gemini-3-flash-preview');
  vi.stubEnv('VITE_APPCHECK_PROVIDER', 'recaptcha-enterprise');
  vi.stubEnv('VITE_APPCHECK_RECAPTCHA_SITE_KEY', '6LdOTzIuAAAAAKpwvIbdyuP8F-X2O7a24aZj0x73');
  vi.stubEnv('VITE_APPCHECK_DEBUG_TOKEN', '');
  vi.stubEnv('VITE_APPCHECK_LIMITED_USE', 'false');
}

describe('firebaseClient startup and App Check resilience', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('reports configured initial runtime status when required env keys are present', async () => {
    const { getInitialRuntimeStatus } = await import('../src/lib/firebaseClient');

    const status = getInitialRuntimeStatus({
      VITE_FIREBASE_API_KEY: 'AIzaTestKey',
      VITE_FIREBASE_PROJECT_ID: 'localshield-hybrid-ai-5678',
      VITE_FIREBASE_APP_ID: '1:123456:web:abcdef',
      VITE_FIREBASE_CLOUD_MODEL: 'gemini-3-flash-preview',
      VITE_APPCHECK_PROVIDER: 'recaptcha-enterprise',
      VITE_APPCHECK_RECAPTCHA_SITE_KEY: '6LdOTzIuAAAAAKpwvIbdyuP8F-X2O7a24aZj0x73'
    });
    expect(status.configured).toBe(true);
    expect(status.projectId).toBe('localshield-hybrid-ai-5678');
    expect(status.cloudModel).toBe('gemini-3-flash-preview');
    expect(status.missingEnvKeys).toEqual([]);
  });

  it('reports unconfigured initial runtime status when required env keys are missing', async () => {
    const { getInitialRuntimeStatus } = await import('../src/lib/firebaseClient');

    const status = getInitialRuntimeStatus({});
    expect(status.configured).toBe(false);
    expect(status.missingEnvKeys).toEqual([
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_APP_ID'
    ]);
  });

  it('resolves initializeFirebaseServices immediately without awaiting App Check getToken', async () => {
    stubValidFirebaseEnv();
    // Simulate recaptcha/enterprise.js blocked by an ad-blocker: getToken never settles
    getTokenMock.mockImplementation(() => new Promise(() => {}));

    const { initializeFirebaseServices } = await import('../src/lib/firebaseClient');
    const handle = await initializeFirebaseServices();

    expect(handle).not.toBeNull();
    expect(handle?.status.configured).toBe(true);
    expect(handle?.status.projectId).toBe('localshield-hybrid-ai-5678');
    expect(handle?.status.cloudModel).toBe('gemini-3-flash-preview');
    expect(handle?.status.appCheck.initialized).toBe(true);
    expect(handle?.status.appCheck.mode).toBe('recaptcha-enterprise');
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('times out refreshAppCheckStatus cleanly after 5s when getToken hangs', async () => {
    vi.useFakeTimers();
    stubValidFirebaseEnv();
    getTokenMock.mockImplementation(() => new Promise(() => {}));

    const { initializeFirebaseServices } = await import('../src/lib/firebaseClient');
    const handle = await initializeFirebaseServices();
    expect(handle).not.toBeNull();

    const refreshPromise = handle!.refreshAppCheckStatus();
    await vi.advanceTimersByTimeAsync(5000);
    const updatedStatus = await refreshPromise;

    expect(updatedStatus.tokenVerified).toBe(false);
    expect(updatedStatus.note).toContain('Timed out after 5000ms');
    expect(handle!.status.appCheck.note).toContain('Timed out after 5000ms');
  });
});
