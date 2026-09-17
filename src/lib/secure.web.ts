// 敏感信息存储（web 预览降级）—— 浏览器无 Keychain，退化为 localStorage
// 注意：仅用于本地预览调试，安全性不等同于原生的 Keychain 加密存储
const PREFIX = 'techdocs.secure.';

export async function secureGet(key: string): Promise<string | null> {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // 忽略
  }
}

export async function secureDelete(key: string): Promise<void> {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // 忽略
  }
}
