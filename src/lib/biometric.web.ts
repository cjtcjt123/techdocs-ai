// 面容解锁（web 预览降级）—— 浏览器里没有生物识别。
//
// expo-local-authentication 自带一个 web stub，但它只有 hasHardwareAsync / isEnrolledAsync
// （两个都恒返回 false），**没有 authenticateAsync** —— 在浏览器里直接调会抛 TypeError。
// 所以这里把两个函数都补全，一律报「不可用」，锁屏于是只走密码分支。
//
// ⚠️ 刻意**不做假通过**（比如弹个「模拟成功」的按钮）：宁可浏览器里少一个按钮，
// 也不让 App 里出现一个「点了一定能进」的解锁 —— 那种东西留在代码里迟早被当成真的。
// 面容长什么样在真机上看，界面位置与样式在浏览器里照常能看到（那一圈与文案都在）。
export type BiometricInfo = {
  available: boolean;
  label: string;
  reason?: string;
};

export function biometricLabel(): string {
  return '面容 ID';
}

export async function biometricInfo(): Promise<BiometricInfo> {
  return {
    available: false,
    label: '面容 ID',
    reason: '浏览器里没有面容解锁 —— 装到手机上才可用（这里只是界面预览）',
  };
}

export async function biometricAuth(): Promise<boolean> {
  return false;
}
