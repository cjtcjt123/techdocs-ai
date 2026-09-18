// 设计令牌 —— UI v3（融合版：B 的状态骨架 + A 的问答内核）
// 一条原则：语义色只用于「状态」，不用于装饰。整屏最多出现一次强调色块。
import { Platform, ViewStyle } from 'react-native';

export const colors = {
  // 主色：紫（唯一强调色）
  primary: '#5e5ce6',
  primaryDeep: '#4b49c9',
  primarySoft: '#efeeff',

  // 语义色（只用于判定 / 状态）
  green: '#1f8a4c',
  greenSoft: '#eef7f1',
  amber: '#b45309',
  amberSoft: '#fdf3e3',
  red: '#c2410c',
  redSoft: '#fdeceb',
  ok: '#1f8a4c',
  okSoft: '#eef7f1',
  warn: '#b45309',
  warnSoft: '#fdf3e3',
  bad: '#c2410c',
  badSoft: '#fdeceb',

  // 中性
  surface: '#ffffff',
  background: '#f4f5f9',
  card: '#ffffff',
  cardAlt: '#f6f6fa',
  text: '#12141a',
  text2: '#3d4453',
  muted: '#8b92a1',
  faint: '#9aa1b2',
  border: '#e6e8f0',
  borderSoft: '#f1f2f6',
  ink: '#12141a',
  inkSoft: '#2c313c',

  // 命中路徽章（关键词 / 语义）
  kw: '#5e5ce6',
  kwSoft: '#efeeff',
  sem: '#1f8a4c',
  semSoft: '#eef7f1',
};

export const radius = { sm: 10, md: 12, lg: 14, xl: 18, xxl: 20, pill: 999 };

export const space = { s0: 4, s1: 6, s2: 12, s3: 18, s4: 26, s5: 34 };

// 等宽字体：数值一律用它，保证 tabular-nums 成列（比参数时不费眼）
export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) as string;

// 阴影：层级只有两级（卡片 / 浮起），避免到处加阴影显脏
export const shadow = {
  none: {} as ViewStyle,
  card: {
    shadowColor: '#101430',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  } as ViewStyle,
  lift: {
    shadowColor: '#14183a',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  } as ViewStyle,
};

// 判定 → 配色（对比屏与徽章共用一张表，避免各处自己挑颜色）
export function verdictColor(v: 'ok' | 'warn' | 'no' | 'na') {
  switch (v) {
    case 'ok':
      return { fg: colors.ok, bg: colors.okSoft };
    case 'warn':
      return { fg: colors.warn, bg: colors.warnSoft };
    case 'no':
      return { fg: colors.bad, bg: colors.badSoft };
    default:
      return { fg: colors.muted, bg: colors.borderSoft };
  }
}
