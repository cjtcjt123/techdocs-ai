// 手机本地模型的纯逻辑层离线测试（不需要真机、不需要网络）
//
// 重点不是「跑通」，而是**判据可证伪**：
//   · GGUF 解析必须先在合成样本上验证「能读出正确字段」+「能挡住坏文件」；
//   · 档位判定必须覆盖边界值（4/6/8 GiB，以及刚好卡在阈值两侧）。
// 一个从没见过它报错的解析器和判定函数，等于没有。
//
// 跑法：node scripts/test-local-models.mjs

const { MODEL_CATALOG, SOURCE_LABEL, parseGgufHeader, looksLikeGguf, quantLabel, tierForMemory, fitForModel, usableBytes, pickForTier, formatBytes, findCatalogModel, systemModelStatus } = await import('../src/lib/local-models.ts');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  →  ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------- 合成 GGUF 头

const GGUF_TYPE = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };

// 手写 GGUF 头 —— 故意把 tokenizer 数组放在关键字段**之后**，与真实文件一致，
// 用来验证「拿到关键字段就提前收手」这条路径真的会走到，而不是把整个数组读完。
function buildGguf({ version = 3, tensorCount = 290, kvs, truncateAt = null, trailingGarbage = 0 }) {
  const parts = [];
  const push = (b) => parts.push(b);
  const u32 = (n) => { const a = new ArrayBuffer(4); new DataView(a).setUint32(0, n, true); push(new Uint8Array(a)); };
  const u64 = (n) => { const a = new ArrayBuffer(8); new DataView(a).setBigUint64(0, BigInt(n), true); push(new Uint8Array(a)); };
  const str = (s) => { const b = new TextEncoder().encode(s); u64(b.length); push(b); };
  const i32 = (n) => { const a = new ArrayBuffer(4); new DataView(a).setInt32(0, n, true); push(new Uint8Array(a)); };
  const f32 = (n) => { const a = new ArrayBuffer(4); new DataView(a).setFloat32(0, n, true); push(new Uint8Array(a)); };

  push(new Uint8Array([0x47, 0x47, 0x55, 0x46])); // 'GGUF'
  u32(version);
  u64(tensorCount);
  u64(kvs.length);
  for (const [key, type, value] of kvs) {
    str(key);
    u32(type);
    if (type === GGUF_TYPE.STRING) str(value);
    else if (type === GGUF_TYPE.UINT32) u32(value);
    else if (type === GGUF_TYPE.INT32) i32(value);
    else if (type === GGUF_TYPE.FLOAT32) f32(value);
    else if (type === GGUF_TYPE.ARRAY) {
      const elemType = value.type;
      u32(elemType);
      u64(value.items.length);
      for (const it of value.items) {
        if (elemType === GGUF_TYPE.STRING) str(it);
        else if (elemType === GGUF_TYPE.UINT32) u32(it);
      }
    } else throw new Error('合成器不支持的取值类型 ' + type);
  }
  for (let i = 0; i < trailingGarbage; i++) push(new Uint8Array([0xab]));

  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of parts) { out.set(b, off); off += b.length; }
  return truncateAt == null ? out : out.subarray(0, Math.min(truncateAt, out.length));
}

// 一个「与真实 Qwen2.5 GGUF 结构一致」的头部：关键字段在前，巨大的词表数组在后
const REALISTIC_KVS = [
  ['general.architecture', GGUF_TYPE.STRING, 'qwen2'],
  ['general.name', GGUF_TYPE.STRING, 'Qwen2.5-1.5B-Instruct'],
  ['general.author', GGUF_TYPE.STRING, 'Alibaba'],
  ['general.file_type', GGUF_TYPE.UINT32, 15],           // 15 = Q4_K_M
  ['general.quantization_version', GGUF_TYPE.UINT32, 2],
  ['qwen2.context_length', GGUF_TYPE.UINT32, 32768],
  ['qwen2.embedding_length', GGUF_TYPE.UINT32, 1536],
  ['qwen2.attention.head_count', GGUF_TYPE.UINT32, 12],
  ['qwen2.rope.freq_base', GGUF_TYPE.FLOAT32, 1000000.0],
  ['tokenizer.ggml.model', GGUF_TYPE.STRING, 'gpt2'],
  ['tokenizer.ggml.tokens', GGUF_TYPE.ARRAY, { type: GGUF_TYPE.STRING, items: Array.from({ length: 300 }, (_, i) => `tok${i}`) }],
];

console.log('\n=== 1. GGUF 头解析：正常路径 ===');
{
  const buf = buildGguf({ kvs: REALISTIC_KVS });
  const r = parseGgufHeader(buf);
  ok('识别为 GGUF', r.ok === true, JSON.stringify(r));
  eq('版本号', r.version, 3);
  eq('tensor 数', r.tensorCount, 290);
  eq('KV 数', r.kvCount, REALISTIC_KVS.length);
  eq('读出 general.name', r.name, 'Qwen2.5-1.5B-Instruct');
  eq('读出 architecture', r.architecture, 'qwen2');
  eq('读出 context_length（不是 4096 这种猜的默认值）', r.contextLength, 32768);
  eq('读出 file_type', r.fileType, 15);
  eq('file_type → 量化标签', r.quant, 'Q4_K_M');
  ok('在词表数组之前就收手（没把 300 项数组读完）', r.partial !== true);
}

console.log('\n=== 1b. 真实文件的键序：数组夹在关键字段之前 ===');
{
  // 这一条是**被真实文件打脸后补的**：真实的 bartowski GGUF 把 general.tags（字符串数组）
  // 排在 general.file_type 前面。第一版解析器「见数组就放弃」，结果量化等级和上下文长度全读不到。
  // 用真实文件的形状锁住这个行为，防止以后又退回去。
  const kvs = [
    ['general.architecture', GGUF_TYPE.STRING, 'qwen2'],
    ['general.name', GGUF_TYPE.STRING, 'Qwen2.5 0.5B Instruct'],
    ['general.tags', GGUF_TYPE.ARRAY, { type: GGUF_TYPE.STRING, items: ['text-generation', 'chat', 'qwen2', 'org-model'] }],
    ['general.languages', GGUF_TYPE.ARRAY, { type: GGUF_TYPE.STRING, items: ['en', 'zh'] }],
    ['general.quantization_version', GGUF_TYPE.UINT32, 2],
    ['general.file_type', GGUF_TYPE.UINT32, 15],
    ['qwen2.context_length', GGUF_TYPE.UINT32, 32768],
    ['tokenizer.ggml.tokens', GGUF_TYPE.ARRAY, { type: GGUF_TYPE.STRING, items: Array.from({ length: 500 }, (_, i) => `tok${i}`) }],
  ];
  const r = parseGgufHeader(buildGguf({ kvs }));
  ok('跨过字符串数组后仍能解析成功', r.ok === true, JSON.stringify(r));
  eq('数组之后照样读出 file_type', r.fileType, 15);
  eq('数组之后照样读出量化标签', r.quant, 'Q4_K_M');
  eq('数组之后照样读出 context_length', r.contextLength, 32768);
  eq('名字也对', r.name, 'Qwen2.5 0.5B Instruct');
}
{
  // 巨大数组（词表规模）必须放弃而不是逐项读 —— 否则一进页面就卡死
  const kvs = [
    ['general.architecture', GGUF_TYPE.STRING, 'qwen2'],
    ['tokenizer.ggml.tokens', GGUF_TYPE.ARRAY, { type: GGUF_TYPE.STRING, items: Array.from({ length: 30000 }, (_, i) => `t${i}`) }],
    ['general.file_type', GGUF_TYPE.UINT32, 15],
  ];
  const r = parseGgufHeader(buildGguf({ kvs }));
  ok('遇到超预算的大数组会收手（不逐项读完）', r.ok === true && r.partial === true, JSON.stringify(r));
  ok('收手后不编造没读到的字段', r.fileType === undefined, String(r.fileType));
}

console.log('\n=== 2. GGUF 头解析：必须挡住的坏例子 ===');
{
  const txt = new TextEncoder().encode('{"__metadata__":{"format":"pt"}}  这不是模型文件'.padEnd(64, 'x'));
  const r = parseGgufHeader(txt);
  ok('把纯文本判为不合法', r.ok === false);
  ok('错误信息点明了「不是 GGUF」', /不是 GGUF/.test(r.error || ''), r.error);
  ok('错误信息给了解法（换成量化 gguf）', /Q4_K_M\.gguf|量化文件/.test(r.error || ''), r.error);
}
{
  // 真实 safetensors 的开头：8 字节小端 JSON 长度 + JSON
  const json = new TextEncoder().encode('{"model.embed_tokens.weight":{"dtype":"BF16","shape":[151936,1536],"data_offsets":[0,466944]}}');
  const head = new Uint8Array(8 + json.length);
  new DataView(head.buffer).setBigUint64(0, BigInt(json.length), true);
  head.set(json, 8);
  const r = parseGgufHeader(head);
  ok('把 safetensors 判为不合法', r.ok === false, JSON.stringify(r));
  ok('safetensors 的报错提到 safetensors', /safetensors/.test(r.error || ''), r.error);
}
{
  const r = parseGgufHeader(new Uint8Array([0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0]));
  ok('文件太短时明确说不合法', r.ok === false);
  ok('短文件报错提到「太小」', /太小/.test(r.error || ''), r.error);
}
{
  // 只有一半的文件：magic 对，但 KV 区被截断、一个字段都没读到
  const full = buildGguf({ kvs: REALISTIC_KVS });
  const r = parseGgufHeader(full.subarray(0, 30));
  ok('关键字段全缺时判为不合法（而不是假装成功）', r.ok === false, JSON.stringify(r));
  ok('截断文件报错提到「截断/损坏」', /截断|损坏/.test(r.error || ''), r.error);
}
{
  // 截到「刚读完架构、还没读到 context_length」—— 应当成功但标记为部分，
  // 且**不能**凭空编一个 contextLength 出来
  const full = buildGguf({ kvs: REALISTIC_KVS });
  let cut = 0;
  const needle = new TextEncoder().encode('general.file_type');
  for (let i = 0; i <= full.length - needle.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) if (full[i + j] !== needle[j]) { hit = false; break; }
    if (hit) { cut = i; break; }
  }
  const r = parseGgufHeader(full.subarray(0, cut));
  ok('中途截断不抛异常', r.ok === true || r.ok === false);
  if (r.ok) {
    eq('截断时读到的架构仍可用', r.architecture, 'qwen2');
    ok('截断时 contextLength 保持为 undefined（不编造）', r.contextLength === undefined, String(r.contextLength));
    ok('截断被标记为 partial', r.partial === true);
  } else {
    ok('截断且无任何字段时报不合法', /截断|损坏/.test(r.error || ''), r.error);
  }
}

console.log('\n=== 3. looksLikeGguf 只认前 4 字节 ===');
eq('GGUF 开头返回 true', looksLikeGguf(new Uint8Array([0x47, 0x47, 0x55, 0x46, 9, 9, 9, 9])), true);
eq('差一字节返回 false', looksLikeGguf(new Uint8Array([0x47, 0x47, 0x55, 0x00])), false);
eq('空数组返回 false', looksLikeGguf(new Uint8Array([])), false);

console.log('\n=== 4. 量化标签 ===');
eq('15 → Q4_K_M', quantLabel(15), 'Q4_K_M');
eq('0 → F32', quantLabel(0), 'F32');
eq('未知编号不崩、原样回显', quantLabel(999), 'file_type 999');
eq('undefined → undefined', quantLabel(undefined), undefined);

console.log('\n=== 5. 机型档位判定（边界） ===');
const GiB = 1024 ** 3;
// 阈值区间是左闭右开：[4,5) → low，[5,7.5) → mid，[7.5,∞) → high。
// 真机只会报 4/6/8 GiB 整，5 GiB 这种值不存在，这里锁的只是「不会有歧义」。
eq('4 GiB → low（iPhone 13）', tierForMemory(4 * GiB), 'low');
eq('6 GiB → mid', tierForMemory(6 * GiB), 'mid');
eq('8 GiB → high（iPhone 18 预期）', tierForMemory(8 * GiB), 'high');
eq('刚过 5 GiB → mid', tierForMemory(5 * GiB + 1), 'mid');
eq('刚好 5 GiB → mid（左闭右开的上界归上一档）', tierForMemory(5 * GiB), 'mid');
eq('略低于 5 GiB → low', tierForMemory(5 * GiB - 1), 'low');
eq('刚好 7.5 GiB → high', tierForMemory(7.5 * GiB), 'high');
eq('略低于 7.5 GiB → mid', tierForMemory(7.5 * GiB - 1), 'mid');
eq('拿不到内存（0）→ low，不崩', tierForMemory(0), 'low');

console.log('\n=== 6. 单模型适配判定（用实测体积） ===');
{
  const m05 = findCatalogModel('qwen2.5-0.5b-q4km');
  const m15 = findCatalogModel('qwen2.5-1.5b-q4km');
  const m3 = findCatalogModel('qwen2.5-3b-q4km');
  const m17 = findCatalogModel('qwen3-1.7b-q4km');
  ok('清单里能找到 0.5B/1.5B/1.7B/3B', !!(m05 && m15 && m3 && m17));

  eq('4 GiB：0.5B → ok（默认给它的那个）', fitForModel(m05.bytes, 4 * GiB), 'ok');
  eq('4 GiB：1.5B → tight（偏紧，不拦但警告）', fitForModel(m15.bytes, 4 * GiB), 'tight');
  eq('4 GiB：3B → no（必须拦）', fitForModel(m3.bytes, 4 * GiB), 'no');

  eq('6 GiB：1.5B → ok', fitForModel(m15.bytes, 6 * GiB), 'ok');
  eq('6 GiB：1.7B → ok', fitForModel(m17.bytes, 6 * GiB), 'ok');
  eq('6 GiB：3B → tight', fitForModel(m3.bytes, 6 * GiB), 'tight');

  eq('8 GiB：3B → ok', fitForModel(m3.bytes, 8 * GiB), 'ok');
  eq('未知内存（0）时不拦', fitForModel(m3.bytes, 0), 'ok');

  ok('4 GiB 的可用内存估算落在 1~2 GB 之间（合理量级）', usableBytes(4 * GiB) > 1 * GiB && usableBytes(4 * GiB) < 2 * GiB, formatBytes(usableBytes(4 * GiB)));
}

console.log('\n=== 7. 默认推荐与清单自检 ===');
eq('4 GiB 的默认推荐是 0.5B', pickForTier('low').id, 'qwen2.5-0.5b-q4km');
eq('8 GiB 的默认推荐是 3B', pickForTier('high').id, 'qwen2.5-3b-q4km');
{
  const ids = new Set();
  let dup = null;
  for (const m of MODEL_CATALOG) { if (ids.has(m.id)) dup = m.id; ids.add(m.id); }
  ok('清单里没有重复 id', dup === null, String(dup));
  ok('每个模型都有镜像地址与 HF 地址', MODEL_CATALOG.every((m) => /^https:\/\//.test(m.mirrorUrl) && /^https:\/\//.test(m.hfUrl)));
  ok('每个模型体积都已实测填入（> 100MB）', MODEL_CATALOG.every((m) => m.bytes > 100 * 1024 ** 2));
  ok('minTier 都是合法档位', MODEL_CATALOG.every((m) => ['low', 'mid', 'high'].includes(m.minTier)));
  ok('每个档位都有推荐模型', ['low', 'mid', 'high'].every((t) => MODEL_CATALOG.some((m) => m.pickFor === t)));
  ok('体积与档位自洽：标 low 的不超过 1.5 GiB', MODEL_CATALOG.filter((m) => m.minTier === 'low').every((m) => m.bytes < 1.5 * GiB));
}

console.log('\n=== 8. 体积格式化 ===');
eq('379 MiB → 379 MB', formatBytes(379 * 1024 ** 2), '379 MB');
eq('940 MiB → 940 MB', formatBytes(940 * 1024 ** 2), '940 MB');
eq('2 GiB → 2.00 GB', formatBytes(2 * 1024 ** 3), '2.00 GB');
eq('0 → 占位符', formatBytes(0), '—');

console.log('\n=== 9. 来源标签完整性 ===');
{
  // 界面上的来源徽章直接查这张表。新增一个来源却忘了加标签，用户会看到空白徽章 ——
  // 这条断言就是防这个。ModelSource 的全部取值从 SYSTEM_MODEL 之外的地方拿不到类型信息，
  // 所以这里把「已知的三个来源」显式列出来，新增来源时这条会失败，提醒一起补。
  const ALL_SOURCES = ['catalog', 'nas', 'file'];
  for (const s of ALL_SOURCES) {
    ok(`来源「${s}」有标签`, typeof SOURCE_LABEL[s] === 'string' && SOURCE_LABEL[s].length > 0, String(SOURCE_LABEL[s]));
  }
  eq('标签表里没有多余项', Object.keys(SOURCE_LABEL).length, ALL_SOURCES.length);
}

console.log('\n=== 10. 系统内置模型的状态是真判断，不是写死的文案 ===');
{
  // 这一条的来历：界面上原本写死「本机不可用」，同屏注释却承诺「换上支持的机型后自动变可用」——
  // 代码里没有任何一处会因换机型而改变。承诺了做不到的事，比不说更糟。
  // 所以状态必须由真实输入算出，且三种状态要真的分得开（用户要做的事完全不同）。
  const G = 1024 ** 3;
  const nonIos = systemModelStatus({ os: 'android', major: 34, memBytes: 12 * G });
  eq('非 iOS → unsupported', nonIos.state, 'unsupported');
  ok('非 iOS 的标签不是「本机不可用」这种死话', nonIos.label !== '本机不可用', nonIos.label);

  const oldIos = systemModelStatus({ os: 'ios', major: 18, memBytes: 8 * G });
  eq('iOS 18（< 26）→ unsupported', oldIos.state, 'unsupported');
  ok('低版本要说清差的是什么', /26/.test(oldIos.label + oldIos.detail), oldIos.label);

  const oldPhone = systemModelStatus({ os: 'ios', major: 26, memBytes: 6 * G });
  eq('iOS 26 但内存 6G（机型不够）→ unsupported', oldPhone.state, 'unsupported');

  // 条件都满足时，如实说「还没接上」，不能假装可用 —— 原生调用通路确实还没写
  const ready = systemModelStatus({ os: 'ios', major: 26, memBytes: 8 * G });
  eq('条件满足 → not-integrated（不是「可用」）', ready.state, 'not-integrated');
  ok('待接入要讲清「不需要下载」（它本来就在系统里）', /不需要下载/.test(ready.detail), ready.detail);

  // 判据必须随输入变化：同一段代码换一组输入就得换一个结论 —— 写死的话这条过不了
  const a = systemModelStatus({ os: 'ios', major: 26, memBytes: 8 * G }).label;
  const b = systemModelStatus({ os: 'ios', major: 18, memBytes: 8 * G }).label;
  ok('版本不同 → 结论不同（证明不是常量）', a !== b, `${a} vs ${b}`);
}


console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
