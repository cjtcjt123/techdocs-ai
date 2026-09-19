/**
 * 自动分类（型号 / 文档类型）的离线契约测试
 *
 * 用法：node scripts/test-classify.mjs
 *
 * 为什么值得单独测：识别结果是资料库分组的**唯一数据来源**。
 * 猜错型号 = 资料分进一个不存在的组（比不分更糟，用户会以为界面在骗他）；
 * 把标准号 ISO 9001 当成型号同样荒谬。所以这里锁死「该认出来的要认出、不该认的别乱认」。
 *
 * 用的是 src/lib/classify.ts 的真实实现，不在脚本里另抄一份。
 */
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.')) {
    const p = fileURLToPath(new URL(specifier, context.parentURL));
    if (!existsSync(p)) {
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (existsSync(p + ext)) return nextResolve(specifier + ext, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
`)
);

const { classifyDoc, pickModel, pickKind, KIND_LABEL } = await import('../src/lib/classify.ts');

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  期望=${JSON.stringify(want)} 实际=${JSON.stringify(got)}`}`);
};

console.log('=== ① 型号：文件名优先 ===');
check('Araldite CY1578 TDS.pdf', classifyDoc('Araldite CY1578 TDS.pdf').model, 'CY1578');
check('带连字符 CY-1578', classifyDoc('CY-1578 树脂.pdf').model, 'CY1578');
check('带空格 HY 5192', classifyDoc('HY 5192.pdf').model, 'HY5192');
check('CY5192-HY5192 体系', classifyDoc('CY5192-HY5192 体系说明.pdf').model, 'CY5192');

console.log('\n=== ② 型号：文件名没有就去正文里找（且要出现两次以上）===');
const tdsBody = 'Araldite CY1578 是一种环氧树脂。CY1578 与 HY1578 配合用于拉挤成型。CY1578 粘度较低。';
check('正文里认出 CY1578', classifyDoc('环氧树脂技术资料.pdf', tdsBody).model, 'CY1578');
check('只出现一次不算', pickModel('这份资料提到 CY1578 一次。'), undefined);

console.log('\n=== ③ 不该被当成型号的噪声 ===');
check('ISO 标准号被排除', pickModel('本产品符合 ISO 9001 与 GB 19001 要求。ISO 9001 是质量管理体系。'), undefined);
check('ASTM 标准号被排除', pickModel('按 ASTM D638 测试。ASTM D638 是拉伸标准。'), undefined);

console.log('\n=== ④ 文档类型 ===');
check('TDS（英文）', classifyDoc('CY1578 Technical Data Sheet.pdf').kind, 'tds');
check('TDS（中文）', classifyDoc('CY1578 技术数据表.pdf').kind, 'tds');
check('规格书', classifyDoc('拉挤工艺采购规格书.pdf').kind, 'spec');
check('技术要求', classifyDoc('CY1578 技术要求.pdf').kind, 'spec');
check('检验报告', classifyDoc('CY5192 检验报告.pdf').kind, 'report');
check('COA', classifyDoc('HY1578 COA.pdf').kind, 'report');
check('安全数据表', classifyDoc('CY1578 MSDS.pdf').kind, 'sds');
check('认不出就留空（不瞎猜）', classifyDoc('随手拍的照片.pdf', '一些文字').kind, undefined);

console.log('\n=== ⑤ 类型也能从正文认（文件名没写时）===');
check('正文说 Technical Data Sheet', classifyDoc('资料.pdf', 'Araldite CY1578\nTechnical Data Sheet\n粘度 25℃').kind, 'tds');

console.log('\n=== ⑥ 类型中文名是短名（卡片副标题只有一行）===');
check('TDS 显示为 TDS', KIND_LABEL.tds, 'TDS');
check('spec 显示为 规格书', KIND_LABEL.spec, '规格书');
check('每个名字都不超过 4 个字', Object.values(KIND_LABEL).every((s) => s.length <= 4), true);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
