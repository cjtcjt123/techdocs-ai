// 敏感信息存储（原生）—— expo-secure-store（Keychain / Keystore）
// web 端由 secure.web.ts 通过 Metro 平台后缀自动替换为 localStorage
import * as SecureStore from 'expo-secure-store';

export async function secureGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // 存储失败不应阻断主流程
  }
}

export async function secureDelete(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // 忽略
  }
}
