// 手机本地模型的纯逻辑层：机型档位判定 / 内置模型清单 / GGUF 文件头解析。
//
// 这一层刻意不碰任何原生 API 与网络，好处是能在 Node 里离线跑测试
// （见 scripts/test-local-models.mjs）—— GGUF 解析和档位判定是「错了会静默出错」的地方，
// 必须能用合成样本验证，不能靠肉眼。

// ---------------------------------------------------------------- 机型档位

export type Tier = 'low' | 'mid' | 'high';

export const TIER_LABEL: Record<Tier, string> = {
  low: '4 GB 档',
  mid: '6 GB 档',
  high: '8 GB 及以上档',
};

// 物理内存 → 档位。阈值取在实际机型值之间（iPhone 实测会报 4/6/8 GiB 整）。
export function tierForMemory(totalBytes: number): Tier {
  const gib = totalBytes / 1024 ** 3;
  if (gib < 5) return 'low';
  if (gib < 7.5) return 'mid';
  return 'high';
}

// 单个模型能不能在这台机器上跑。
//
// 这组常数是**估算**，不是实测：iOS 前台 App 可用内存约等于物理内存的一半（超了被 jetsam 杀），
// 再扣掉 RN 运行时与 WebView 的固定开销。真实值要在真机上校准 —— iPhone 13 那一轮实测后回来改这里。
const MEM_RATIO = 0.5;          // 前台可用 ≈ 物理内存的一半
const MEM_OVERHEAD = 400 * 1024 ** 2; // 固定开销：App 本体 + RN/JS 运行时
const OK_RATIO = 0.55;          // 权重 ≤ 可用量的 55% → 舒服
const TIGHT_RATIO = 0.8;        // ≤ 80% → 偏紧

export function usableBytes(totalBytes: number): number {
  return Math.max(0, totalBytes * MEM_RATIO - MEM_OVERHEAD);
}

export type Fit = 'ok' | 'tight' | 'no';

export function fitForModel(weightsBytes: number, totalBytes: number): Fit {
  if (totalBytes <= 0) return 'ok'; // 拿不到内存信息时不拦，交给运行时兜底
  const usable = usableBytes(totalBytes);
  if (weightsBytes <= usable * OK_RATIO) return 'ok';
  if (weightsBytes <= usable * TIGHT_RATIO) return 'tight';
  return 'no';
}

export const FIT_TEXT: Record<Fit, string> = {
  ok: '这台机器跑得动',
  tight: '偏紧，加载后可能被系统杀掉',
  no: '超出这台机器的内存，不建议装',
};

// ---------------------------------------------------------------- 模型清单
//
// 所有体积都是**实测**（对下载地址发 HEAD 取 content-length），不是估的。
// 所有 URL 都已实测返回 206，可直接下。国内默认走 hf-mirror.com 镜像。

export interface CatalogModel {
  id: string;
  name: string;
  params: string;
  quant: string;
  bytes: number;
  /** 建议上下文长度（不是模型上限，是我们在手机上愿意开的值） */
  ctx: number;
  /** 下载地址（国内镜像） */
  mirrorUrl: string;
  /** 原始 HuggingFace 地址 */
  hfUrl: string;
  /** 最低可运行档位 */
  minTier: Tier;
  note: string;
  /** 默认推荐（按档位各一个） */
  pickFor?: Tier;
}

const HF = 'https://huggingface.co';
const MIRROR = 'https://hf-mirror.com';

function gguf(repo: string, file: string, bytes: number) {
  return { mirrorUrl: `${MIRROR}/${repo}/resolve/main/${file}`, hfUrl: `${HF}/${repo}/resolve/main/${file}`, bytes };
}
const MiB = 1024 ** 2;

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'qwen2.5-0.5b-q4km',
    name: 'Qwen2.5-0.5B-Instruct',
    params: '0.5B',
    quant: 'Q4_K_M',
    ...gguf('bartowski/Qwen2.5-0.5B-Instruct-GGUF', 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', 379 * MiB),
    ctx: 4096,
    minTier: 'low',
    pickFor: 'low',
    note: '最小可用中文模型，任何机型都稳。质量只够短问简答',
  },
  {
    id: 'gemma-3-1b-q4km',
    name: 'Gemma-3-1B-it',
    params: '1B',
    quant: 'Q4_K_M',
    ...gguf('bartowski/google_gemma-3-1b-it-GGUF', 'google_gemma-3-1b-it-Q4_K_M.gguf', 768 * MiB),
    ctx: 4096,
    minTier: 'low',
    note: '速度快、英文强；中文一般，作备选',
  },
  {
    id: 'qwen2.5-1.5b-q4km',
    name: 'Qwen2.5-1.5B-Instruct',
    params: '1.5B',
    quant: 'Q4_K_M',
    ...gguf('bartowski/Qwen2.5-1.5B-Instruct-GGUF', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf', 940 * MiB),
    ctx: 4096,
    minTier: 'low',
    pickFor: 'mid',
    note: '中文问答的甜点位：0.5B 明显不如它，4 GB 机器也扛得住（偏紧）',
  },
  {
    id: 'qwen3-1.7b-q4km',
    name: 'Qwen3-1.7B',
    params: '1.7B',
    quant: 'Q4_K_M',
    ...gguf('bartowski/Qwen_Qwen3-1.7B-GGUF', 'Qwen_Qwen3-1.7B-Q4_K_M.gguf', 1223 * MiB),
    ctx: 4096,
    minTier: 'mid',
    note: '新架构，同体积下指令跟随比 2.5 代更稳',
  },
  {
    id: 'qwen2.5-3b-q4km',
    name: 'Qwen2.5-3B-Instruct',
    params: '3B',
    quant: 'Q4_K_M',
    ...gguf('bartowski/Qwen2.5-3B-Instruct-GGUF', 'Qwen2.5-3B-Instruct-Q4_K_M.gguf', 1840 * MiB),
    ctx: 4096,
    minTier: 'high',
    pickFor: 'high',
    note: '本地能拿到的「最像样」，长文本整理够用。6 GB 起',
  },
];

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** 按档位给出默认推荐（第一次打开模型管理页时预选的那一个） */
export function pickForTier(tier: Tier): CatalogModel {
  const exact = MODEL_CATALOG.find((m) => m.pickFor === tier);
  if (exact) return exact;
  // 没有精确匹配就退到「该档位跑得动的最小模型」
  const order: Tier[] = ['low', 'mid', 'high'];
  const idx = order.indexOf(tier);
  return [...MODEL_CATALOG]
    .filter((m) => order.indexOf(m.minTier) <= idx)
    .sort((a, b) => b.bytes - a.bytes)[0] || MODEL_CATALOG[0];
}

// ---------------------------------------------------------------- GGUF 解析
//
// 只读文件头。用途有两个：
//  ① 导入 .gguf 时校验「这到底是不是 GGUF」，并把量化等级、真实上下文长度读出来显示；
//  ② 挡住改名成 .gguf 的 safetensors/bin —— 那种文件喂给 llama.cpp 只会崩，得在导入时就明确说清。

export interface GgufInfo {
  ok: boolean;
  error?: string;
  version?: number;
  tensorCount?: number;
  kvCount?: number;
  name?: string;
  architecture?: string;
  contextLength?: number;
  fileType?: number;
  quant?: string;
  /** 缓冲区读完但关键信息已到手（正常，GGUF 的词表数组很大） */
  partial?: boolean;
}

// llama.cpp 的 ggml_type 枚举（只列会被写进 general.file_type 的部分）
const FILE_TYPE_LABEL: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ2_S',
  28: 'IQ4_XS', 29: 'I8', 30: 'I16', 31: 'I32', 32: 'I64', 33: 'F64',
  34: 'IQ1_M', 35: 'BF16', 36: 'Q4_0_4_4', 37: 'Q4_0_4_8', 38: 'Q4_0_8_8',
  39: 'TQ1_0', 40: 'TQ2_0', 41: 'IQ4_NL_4_4',
};

export function quantLabel(fileType: number | undefined): string | undefined {
  if (fileType == null) return undefined;
  return FILE_TYPE_LABEL[fileType] || `file_type ${fileType}`;
}

/** 只看前 4 个字节，用于「这是不是 GGUF」的判断 */
export function looksLikeGguf(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x47 && buf[2] === 0x55 && buf[3] === 0x46;
}

// GGUF 值类型
const T_UINT8 = 0, T_INT8 = 1, T_UINT16 = 2, T_INT16 = 3, T_UINT32 = 4, T_INT32 = 5,
  T_FLOAT32 = 6, T_BOOL = 7, T_STRING = 8, T_ARRAY = 9, T_UINT64 = 10, T_INT64 = 11, T_FLOAT64 = 12;

const SCALAR_SIZE: Record<number, number> = {
  [T_UINT8]: 1, [T_INT8]: 1, [T_UINT16]: 2, [T_INT16]: 2, [T_UINT32]: 4, [T_INT32]: 4,
  [T_FLOAT32]: 4, [T_BOOL]: 1, [T_UINT64]: 8, [T_INT64]: 8, [T_FLOAT64]: 8,
};

// 跳过数组时的项数上限。词表数组（十几万项）会超这个数 → 直接放弃（此时关键字段早已到手）。
const ARRAY_ITEM_BUDGET = 20000;

/**
 * 解析 GGUF 文件头。
 * buf 只需要是文件的**前若干字节**（给 512 KB 足够），不必是整份文件。
 */
export function parseGgufHeader(buf: Uint8Array): GgufInfo {
  if (buf.length < 24) return { ok: false, error: '文件太小，读不到 GGUF 文件头' };
  if (!looksLikeGguf(buf)) {
    return {
      ok: false,
      error: '这不是 GGUF 文件（开头不是 GGUF 标识）。若下载的是 .safetensors / pytorch_model.bin，那是原始权重，手机跑不了，请换成 *-Q4_K_M.gguf 这类量化文件。',
    };
  }

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 4;
  // out 提到 try 外面：缓冲区读不完时要能把它已经读到的字段带回给调用方
  const out: GgufInfo = { ok: true };
  try {
    out.version = dv.getUint32(p, true); p += 4;
    out.tensorCount = Number(dv.getBigUint64(p, true)); p += 8;
    out.kvCount = Number(dv.getBigUint64(p, true)); p += 8;

    const readStr = (): string => {
      const len = Number(dv.getBigUint64(p, true)); p += 8;
      if (len > buf.length) throw new Error('EOS');
      const s = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(p, p + len));
      p += len;
      return s;
    };

    // 读了几个 key 就够？general.* 与 *.context_length 都在词表数组前面，
    // 拿到需要的就能停 —— 否则会被 tokenizer.ggml.tokens 这种几千项数组拖爆。
    const need = () => !(out.name && out.architecture && out.contextLength != null && out.fileType != null);

    let guard = Math.min(out.kvCount, 4096);
    while (guard-- > 0 && p < buf.length) {
      if (!need()) break;
      const key = readStr();
      const vtype = dv.getUint32(p, true); p += 4;

      if (vtype === T_ARRAY) {
        // 数组要**真的跳过**，不能一见数组就放弃：实测真实的 bartowski GGUF 把
        // general.tags（字符串数组）排在 general.file_type 之前，一放弃就读不到量化等级。
        // 但要给项数设预算 —— tokenizer.ggml.tokens 有十几万项，那种数组不该逐项读
        // （真到那里时我们早就拿到关键字段并 break 了，走不到这一步）。
        const elemType = dv.getUint32(p, true); p += 4;
        const count = Number(dv.getBigUint64(p, true)); p += 8;
        if (count > ARRAY_ITEM_BUDGET) throw new Error('EOS');
        for (let i = 0; i < count; i++) {
          if (elemType === T_STRING) readStr();
          else if (elemType in SCALAR_SIZE) p += SCALAR_SIZE[elemType];
          else throw new Error('EOS'); // 嵌套数组一律不处理
        }
      } else if (vtype === T_STRING) {
        const v = readStr();
        if (key === 'general.name') out.name = v;
        else if (key === 'general.architecture') out.architecture = v;
      } else if (vtype in SCALAR_SIZE) {
        const size = SCALAR_SIZE[vtype];
        let num = 0;
        if (size === 1) num = vtype === T_INT8 ? dv.getInt8(p) : dv.getUint8(p);
        else if (size === 2) num = vtype === T_INT16 ? dv.getInt16(p, true) : dv.getUint16(p, true);
        else if (size === 4) num = vtype === T_INT32 ? dv.getInt32(p, true) : vtype === T_FLOAT32 ? dv.getFloat32(p, true) : dv.getUint32(p, true);
        else num = Number(dv.getBigInt64(p, true));
        p += size;
        if (key.endsWith('.context_length')) out.contextLength = num;
        else if (key === 'general.file_type') out.fileType = num;
      } else {
        throw new Error('EOS');
      }
    }

    out.quant = quantLabel(out.fileType);
    return out;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // 「缓冲区读完」有两种表现：① 我们自己抛的 EOS 哨兵；② DataView 越界抛的 RangeError。
    // 两个都要当成「正常读完了」—— 因为 GGUF 头部后面跟着巨大的词表数组，
    // 我们本来就只读前几百 KB，读到这里读不下去是预期内的，不是文件损坏。
    const eos = e?.message === 'EOS' || /outside the bounds|out of range/i.test(msg);
    if (eos) {
      out.quant = quantLabel(out.fileType);
      out.partial = true;
      // 但「读完了」和「读到东西了」是两回事：只有一句头计数、关键字段一个都没拿到，
      // 说明这文件本身就被截断了，必须报错而不是假装识别成功。
      const useful = !!(out.name || out.architecture || out.contextLength != null || out.fileType != null);
      if (!useful) {
        return {
          ok: false,
          error: `GGUF 文件头不完整或已被截断（只读到 ${buf.length} 字节），无法确认这是可用的模型文件。`,
        };
      }
      return out;
    }
    return { ok: false, error: `GGUF 文件头解析失败：${msg}` };
  }
}

/** 把解析结果里「有多少说多少」拼成一句人类可读的描述 */
export function describeGguf(info: GgufInfo, fileName: string): string {
  if (!info.ok) return info.error || '不是有效的 GGUF 文件';
  const bits: string[] = [];
  if (info.quant) bits.push(info.quant);
  if (info.contextLength) bits.push(`上下文 ${info.contextLength}`);
  if (info.architecture) bits.push(info.architecture);
  if (!bits.length) bits.push('未读到量化与上下文信息');
  return `${fileName}：${bits.join(' · ')}`;
}

// ---------------------------------------------------------------- 杂项

export function formatBytes(n: number): string {
  if (!n || n <= 0) return '—';
  const mb = n / MiB;
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 系统内置模型（Apple 智能）：不下载、不可替换，只在支持的机型上出现 */
export const SYSTEM_MODEL = {
  id: '__system__',
  name: 'Apple 系统内置模型',
  approxParams: '约 3B',
  requirement: 'iOS 26 且芯片 A17 Pro 及以上（iPhone 15 Pro / 16 / 17 / 18）',
};

/** A17 Pro 及以上机型的内存下限（8 GiB）。用它当机型档位的代理量：
 *  A17 Pro / A18 / A18 Pro 的 iPhone 一律 8GB，而更早的 A16 是 6GB —— 分得开。 */
const SYSTEM_MODEL_MIN_MEM = 8 * 1024 ** 3;
/** 系统模型所要求的最低 iOS 大版本 */
const SYSTEM_MODEL_MIN_IOS = 26;

export type SystemModelState = 'unsupported' | 'pending' | 'not-integrated';

export interface SystemModelStatus {
  state: SystemModelState;
  /** 徽章上的短标签 */
  label: string;
  /** 卡片里那句解释：说清「为什么现在是这个状态」，以及用户要不要做什么 */
  detail: string;
}

/**
 * 系统内置模型在本机到底能不能用。
 *
 * **纯函数**（不 import react-native）：三个判断依据由调用方把真实值传进来，
 * 这样它能在 Node 里被离线测试兜住 —— 而判断逻辑恰恰是最该被兜住的那类代码。
 *
 * 三种状态必须分开，因为用户要做的事完全不同：
 *   · unsupported      —— 这台机器根本不具备条件（非 iOS / 版本低 / 内存不够），换机器才可能有用
 *   · pending          —— 条件具备，但还没接入（需要 iOS 26 的原生接口，我们还没写）
 *   · not-integrated   —— 同 pending 的区分留给将来：真接上之后这里要返回别的状态
 *
 * ⚠️ 不要在界面上写死「本机不可用」并承诺「换机型后自动变可用」：那是句空话，
 * 代码里没有任何一处会因为换了机型而改变显示 —— 承诺了做不到的事比不说更糟。
 */
export function systemModelStatus(env: {
  os?: string;
  major?: number;
  memBytes?: number;
}): SystemModelStatus {
  const os = String(env.os || '').toLowerCase();
  const major = Number(env.major) || 0;
  const mem = Number(env.memBytes) || 0;

  if (os && os !== 'ios') {
    return {
      state: 'unsupported',
      label: '仅 iOS',
      detail: `系统内置模型由 iOS 提供，当前是 ${os}，用不了这一项。其余来源不受影响。`,
    };
  }
  if (major && major < SYSTEM_MODEL_MIN_IOS) {
    return {
      state: 'unsupported',
      label: `需 iOS ${SYSTEM_MODEL_MIN_IOS}`,
      detail: `当前系统版本不满足：${SYSTEM_MODEL.requirement}。`,
    };
  }
  if (mem && mem < SYSTEM_MODEL_MIN_MEM) {
    return {
      state: 'unsupported',
      label: '机型不满足',
      detail: `这台设备的内存档位装不下系统模型：${SYSTEM_MODEL.requirement}。`,
    };
  }
  // 条件具备，但这一项目前还没有真正的调用通路：Apple 的端侧模型要经 iOS 26 的原生
  // 接口调用，而那部分原生代码还没写。如实说「还没接上」，别装作已经能用。
  return {
    state: 'not-integrated',
    label: '待接入',
    detail: '这台设备的条件满足，但系统模型要经过 iOS 26 的原生接口才能调用 —— 那部分还没接上，接上后这一项会直接可用（不需要下载任何文件）。',
  };
}

// ---------------------------------------------------------------- 已装模型（设备上的实例）

export type ModelSource = 'catalog' | 'nas' | 'file';

/**
 * 来源的界面标签。放在这里而不是界面文件里，是为了让「新增一个来源」这件事
 * 有一个能被测试兜住的地方 —— 漏了标签，用户会看到一个空白徽章。
 */
export const SOURCE_LABEL: Record<ModelSource, string> = {
  catalog: '在线下载',
  nas: 'NAS 拉取',
  file: '文件导入',
};

export interface LocalModelRecord {
  /** 与清单 id 一致（装了同一个模型的多个量化时带后缀） */
  id: string;
  name: string;
  /** 设备上的绝对路径（file:// 形式） */
  uri: string;
  bytes: number;
  quant?: string;
  /** 文件里读到的真实上下文上限；没读到就不填，不编造 */
  ctxFromFile?: number;
  /** 实际会用的上下文（min(文件上限, 我们愿意开的)） */
  ctxUse: number;
  /**
   * 这个文件是怎么来的。
   * 可缺省：来源靠沙盒里的侧车文件记录，用户自己用「文件」App 塞进沙盒的模型没有这份记录 ——
   * 这时候宁可不标，也不要默认成「在线下载」（那是编的）。
   */
  source?: ModelSource;
  importedAt: number;
}
