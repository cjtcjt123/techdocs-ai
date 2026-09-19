// 设置持久化：非敏感字段存 sqlite kv，API Key 走 secure 层（原生 Keychain / web localStorage）
import { secureGet, secureSet } from './secure';
import { kvGet, kvSet } from './storage';
import { ModelConfig, DataStrategy, ModelSource, NasConnection, RetrievalConfig } from '../types';

const API_KEY_STORE = 'model_api_key';
const NAS_PW_STORE = 'nas_password';
const SETTINGS_KEY = 'app_settings';

export interface PrivacySettings {
  /**
   * 启动时锁定 App。
   *
   * ⚠️ 这个字段**以前叫 `faceID`**，但它的语义从来只是「启动时锁一下」——
   * 名字却暗示它管面容，于是界面上写「隐私锁（Face ID / 密码）」、实际只有 4 位密码，
   * 一挂就是很久（用户凭手感发现「好像只有密码」）。改名的目的就是断掉这个误会。
   * 旧值由 loadSettings() 从 `faceID` 迁移过来。
   */
  lock: boolean;
  /** 允许用面容 / 指纹解锁。默认开 —— 有硬件且已录入时不必再让人点一次开关 */
  biometric: boolean;
  offlineMode: boolean;
  cloudConfirm: boolean;
}

// 文档解析服务（跑在 NAS 上的 nas-parse，PyMuPDF 解 PDF 比手机端准）
// 只填了 endpoint 才会走 NAS；不填 = 纯手机本地解析，完全离线可用
export interface ParseServiceConfig {
  endpoint?: string; // 如 http://192.168.0.109:8787
  token?: string; // 服务端设了 AUTH_TOKEN 才需要
}

// 嵌入服务（语义检索用）：把文本转成向量，做「换个说法也能搜到」
// 两种填法都支持，客户端自动识别：NAS 上的 nas-parse（/embed）或任意 OpenAI 兼容服务（/embeddings）
// 不填 = 只用关键词检索（BM25），完全离线可用
export interface EmbeddingConfig {
  endpoint?: string; // NAS: http://192.168.0.109:8787　云端: https://api.openai.com/v1
  token?: string; // 服务端设了 AUTH_TOKEN（或云端 API Key）才需要
  model?: string; // 云端必填（如 text-embedding-3-small）；NAS 上由服务端决定，可留空
}

export interface AppSettings {
  modelConfig: ModelConfig; // 含 apiKey（从 secure 层注入）
  dataStrategy: DataStrategy;
  nas?: NasConnection; // NAS 连接（密码从 secure 层注入）
  parseService?: ParseServiceConfig; // PDF 高精度解析服务
  embedding?: EmbeddingConfig; // 语义检索用的嵌入服务
  privacy: PrivacySettings;
  /**
   * 符合性检查结果的导出格式。
   *
   * 没有 'pdf'：手机上生成 PDF 要引入排版/字体子系统（新依赖 + 拖累出包流水线），
   * 而 iOS 分享面板里「打印 → 存储为 PDF」本来就能一步得到 PDF。做不到的选项不摆在界面上 ——
   * 摆着就是一个「改了没反应」的空壳开关，而这个项目已经吃过这个亏。
   */
  exportFormat: 'markdown' | 'csv';
  retrieval: RetrievalConfig; // 检索范围与条数（问答时可快速调整）
  /**
   * 我自己的分类表（有序）。资料库「按分类分组」和问答「只查某个分类」都从这里取值。
   *
   * ⚠️ 分类名是**文档 meta.category 的取值来源**，删掉分类不会清掉已归入文档的这个值
   * （见 DocMeta.category 的注释）—— 所以这里只管「有哪些可选」，不负责对存量文档做级联。
   * 空数组 = 用户还没建分类，界面上「按分类分组」仍可用（那时只有「未分组」一堆）。
   */
  categories?: string[];
  /**
   * 新导入的资料默认归入哪个分类。空 / 不在 categories 里 = 不自动归类（默认行为）。
   * 存在理由：一批资料通常同属一个行业，让用户每次导入都手动指派一次太烦；
   * 但直接猜又猜不准 —— 所以做成「用户自己指定一个默认值」，不指定就不动。
   */
  defaultCategory?: string;
  /** 本地模型下载是否走国内镜像（hf-mirror）。默认走 —— 直连 huggingface.co 在国内大概率超时 */
  localMirror?: boolean;
}

export function defaultSettings(): AppSettings {
  return {
    modelConfig: { source: 'api', provider: 'openai', baseURL: '', apiKey: '', model: 'gpt-4o-mini' },
    dataStrategy: 'local',
    privacy: { lock: false, biometric: true, offlineMode: false, cloudConfirm: false },
    exportFormat: 'markdown',
    retrieval: { topK: 8, onlyPinned: false, tags: [] },
    localMirror: true,
  };
}

/**
 * 分类名校验：必须是字符串、非空、且**真的在分类表里**。
 *
 * 用在两处（`retrieval.category` / `defaultCategory`）：分类被用户删掉后，这两个字段会变成
 * 「指向一个已不存在的分类」—— 不清掉就会出现「按不存在的分类检索（命中 0 条，看起来像模型瞎答）」
 * 或「新导入的资料归进一个界面上看不见的分类」。
 */
function sanitizeCategory(v: unknown, table: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const name = v.trim();
  if (!Array.isArray(table)) return undefined;
  return table.includes(name) ? name : undefined;
}

export async function loadSettings(): Promise<AppSettings> {
  const apiKey = (await secureGet(API_KEY_STORE)) || '';
  const nasPw = (await secureGet(NAS_PW_STORE)) || '';
  const raw = await kvGet(SETTINGS_KEY);
  if (!raw) {
    return { ...defaultSettings(), modelConfig: { ...defaultSettings().modelConfig, apiKey } };
  }
  try {
    const parsed = JSON.parse(raw);
    const mc = parsed.modelConfig || {};
    // 归一化旧来源值：'official' / 'nas' 并入 'api'，避免 UI 出现「未选中」
    const normalizedSource: ModelSource = mc.source === 'local' ? 'local' : 'api';
    // 旧版本里导出格式有 'pdf' 选项（实际做不到）。存量设置里可能存着 'pdf'，
    // 不归一化的话界面三个分段全部未选中，而导出会静默按 CSV 走 —— 又是一个「设置没反应」。
    const exportFormat = parsed.exportFormat === 'csv' ? 'csv' : 'markdown';
    return {
      ...defaultSettings(),
      ...parsed,
      exportFormat,
      modelConfig: { ...defaultSettings().modelConfig, ...mc, source: normalizedSource, apiKey },
      nas: parsed.nas ? { ...parsed.nas, user: parsed.nas.user || '' } : undefined,
      // 隐私设置：旧版本这个字段叫 faceID（语义就是「启动时锁定」）→ 迁移到 lock。
      // 不迁移的话，老用户升级后锁会静悄悄关掉（存的是 faceID，读的是 lock）。
      // 顺序要紧：先铺开存量值，再用 lock 显式覆盖，这样两种字段名都读得到。
      privacy: {
        ...defaultSettings().privacy,
        ...(parsed.privacy || {}),
        lock: !!(parsed.privacy?.lock ?? parsed.privacy?.faceID),
      },
      // 旧版本无 retrieval 字段，补齐默认值；tags 保证是数组（旧数据可能是 null/undefined）
      retrieval: {
        ...defaultSettings().retrieval,
        ...(parsed.retrieval || {}),
        tags: Array.isArray(parsed.retrieval?.tags) ? parsed.retrieval.tags : [],
        topK: Number(parsed.retrieval?.topK) > 0 ? Number(parsed.retrieval.topK) : 8,
        // 分类被删掉后，检索配置里可能还留着一个已经不存在的分类名 → 清掉，
        // 否则问答会「按一个不存在的分类检索」→ 命中 0 条，用户看到的是「模型瞎答」。
        category: sanitizeCategory(parsed.retrieval?.category, parsed.categories),
      },
      // 分类表：保证是字符串数组（去空、去重、trim）。旧设置没有这个字段 → 空表。
      categories: Array.isArray(parsed.categories)
        ? Array.from(new Set(parsed.categories.filter((c: unknown) => typeof c === 'string').map((c: string) => c.trim()).filter(Boolean)))
        : [],
      // 默认分类必须还在分类表里 —— 分类被删了就失效，不然新导入会归进一个看不见的分类
      defaultCategory: sanitizeCategory(parsed.defaultCategory, parsed.categories),
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
  // NAS 密码不含在 NasConnection 内，由 store 单独通过 secureSet 落盘
}

