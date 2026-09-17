// 设置持久化：非敏感字段存 sqlite kv，API Key 走 secure 层（原生 Keychain / web localStorage）
import { secureGet, secureSet } from './secure';
import { kvGet, kvSet } from './storage';
import { ModelConfig, DataStrategy } from '../types';

const API_KEY_STORE = 'model_api_key';
const SETTINGS_KEY = 'app_settings';

export interface PrivacySettings {
  faceID: boolean;
  offlineMode: boolean;
  cloudConfirm: boolean;
}

export interface AppSettings {
  modelConfig: ModelConfig; // 含 apiKey（从 secure 层注入）
  dataStrategy: DataStrategy;
  privacy: PrivacySettings;
  exportFormat: 'markdown' | 'csv' | 'pdf';
}

export function defaultSettings(): AppSettings {
  return {
    modelConfig: { source: 'official', provider: 'openai', baseURL: '', apiKey: '', model: 'gpt-4o-mini' },
    dataStrategy: 'local',
    privacy: { faceID: false, offlineMode: false, cloudConfirm: false },
    exportFormat: 'markdown',
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const apiKey = (await secureGet(API_KEY_STORE)) || '';
  const raw = await kvGet(SETTINGS_KEY);
  if (!raw) {
    return { ...defaultSettings(), modelConfig: { ...defaultSettings().modelConfig, apiKey } };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings(),
      ...parsed,
      modelConfig: { ...defaultSettings().modelConfig, ...(parsed.modelConfig || {}), apiKey },
      privacy: { ...defaultSettings().privacy, ...(parsed.privacy || {}) },
    };
  } catch {
    return { ...defaultSettings(), modelConfig: { ...defaultSettings().modelConfig, apiKey } };
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const { modelConfig, ...rest } = s;
  await kvSet(SETTINGS_KEY, JSON.stringify(rest));
  if (modelConfig.apiKey) {
    await secureSet(API_KEY_STORE, modelConfig.apiKey);
  }
}
