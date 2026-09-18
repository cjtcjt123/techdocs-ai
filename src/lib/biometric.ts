// 面容 / 指纹解锁（原生实现）。web 端由 Metro 按 .web.ts 后缀替换成 biometric.web.ts。
//
// 为什么不直接在 LockScreen 里 import expo-local-authentication，而要包一层：
//   ① 它的 web stub 里**没有 authenticateAsync** —— 浏览器上直接调是 TypeError，不是「返回 false」。
//      必须由降级层兜住（见 biometric.web.ts）。
//   ② 「这台设备到底能不能用面容」要在锁屏和「我的」页两处用，判断逻辑只该写一遍，
//      否则一处改了另一处忘改，就会出现「设置里说能用、锁屏上什么都没发生」。
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

export type BiometricInfo = {
  /** 硬件可用 **且** 系统里已录入 —— 两个都满足才谈得上「能用面容解锁」 */
  available: boolean;
  /** 解锁方式在本机的叫法，用来拼界面文案 */
  label: string;
  /** 不可用时的原因，直接展示给用户。缺了它，开关打开后没反应就成了「空壳开关」 */
  reason?: string;
};

export function biometricLabel(): string {
  return Platform.OS === 'ios' ? '面容 ID' : '指纹 / 面容';
}

export async function biometricInfo(): Promise<BiometricInfo> {
  const label = biometricLabel();
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) {
      return { available: false, label, reason: '这台设备没有面容 / 指纹硬件' };
    }
    if (!(await LocalAuthentication.isEnrolledAsync())) {
      // 这条最重要：硬件有、但用户没去系统里录。不说清楚的话，用户只会觉得 App 坏了。
      const where = Platform.OS === 'ios' ? '「设置 → 面容 ID 与密码」' : '系统安全设置';
      return { available: false, label, reason: `系统里还没录入${label} —— 先去${where}录一个，回来就能用` };
    }
    return { available: true, label };
  } catch (e: any) {
    return { available: false, label, reason: e?.message || '读取生物识别状态失败' };
  }
}

/** 刷一次脸 / 按一次指纹。通过返回 true；认不出、取消、报错一律 false。 */
export async function biometricAuth(reason: string): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      // ⚠️ 必须关掉系统密码回退：iOS 会把它当成「App 密码」，但那是**设备**密码，
      // 跟这个 App 的 6 位密码是两回事。回退开着的话，知道设备密码的人能直接绕过 App 密码进来。
      disableDeviceFallback: true,
      cancelLabel: '用密码',
    });
    return !!r.success;
  } catch {
    return false;
  }
}
