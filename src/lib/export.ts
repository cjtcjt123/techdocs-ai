// 导出工具：无新依赖。原生走系统分享面板，浏览器走剪贴板。
// 从 ChatScreen 抽出来，是为了让「对比」页共用同一份 CSV 格式 —— 两边导出的表头必须一致。
import { Platform, Share } from 'react-native';
import type { ComplianceResult, Conversation } from '../types';

export function csvCell(s: string): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

export function complianceToCsv(r: ComplianceResult): string {
  const head = '项目,要求,实际,判定,来源';
  const rows = r.items.map((it) =>
    [
      it.item,
      it.required,
      it.actual,
      it.verdict === 'ok' ? '满足' : it.verdict === 'warn' ? '差一点' : '不满足',
      it.source || '',
    ]
      .map(csvCell)
      .join(',')
  );
  return [head, ...rows, '', `结论,${csvCell(r.conclusion)},模型,${csvCell(r.model)}`].join('\n');
}

/**
 * 符合性检查 → Markdown 表格。
 *
 * 与 complianceToCsv 是同一份数据的两种排版，共用「导出格式」这个设置项：
 * 贴进飞书 / 邮件用 Markdown 顺手，导进 Excel 用 CSV。两种都要，但不必都默认。
 */
export function complianceToMarkdown(r: ComplianceResult): string {
  // 单元格里的 | 必须转义，否则列数会被内容撑歪（型号名、备注里带 | 是真实存在的）
  const cell = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const verdict = (v: string) => (v === 'ok' ? '满足' : v === 'warn' ? '差一点' : '不满足');
  const lines = [
    `| 项目 | 要求 | 实际 | 判定 | 来源 |`,
    `| --- | --- | --- | --- | --- |`,
    ...r.items.map(
      (it) =>
        `| ${cell(it.item)} | ${cell(it.required)} | ${cell(it.actual)} | ${verdict(it.verdict)} | ${cell(it.source || '')} |`
    ),
    '',
    `**结论**：${r.conclusion}`,
    '',
    `模型：${r.model}`,
  ];
  return lines.join('\n');
}

export type ExportFormat = 'markdown' | 'csv';

/**
 * 按用户选定的格式产出符合性检查文本。
 *
 * 存在的意义：格式判断只能有一处。调用方各判一次，迟早有一处漏判 ——
 * 症状是「设置里改了格式，某个入口还是老样子」，也就是当初那个「空壳开关」。
 * 顺带说明为什么没有 PDF：手机上生成 PDF 需要引入排版/字体子系统（新依赖 + 拖累出包流水线），
 * 而「分享面板 → 打印 → 存为 PDF」在 iOS 上本来就能一步得到 PDF，不值得为此加依赖。
 */
export function complianceToFormat(r: ComplianceResult, fmt: ExportFormat): { text: string; ext: 'md' | 'csv' } {
  return fmt === 'markdown'
    ? { text: complianceToMarkdown(r), ext: 'md' }
    : { text: complianceToCsv(r), ext: 'csv' };
}

export function convToMarkdown(c: Conversation, title: string): string {
  const lines: string[] = [`# ${title}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
  c.messages.forEach((m) => {
    lines.push(m.role === 'user' ? '## 我' : '## 助手', '', m.content || '（无文字）');
    if (m.attachments?.length) {
      lines.push('', `附件：${m.attachments.map((a) => a.name).join('、')}`);
    }
    if (m.compliance) {
      lines.push('', '### 符合性检查明细', '', '```csv', complianceToCsv(m.compliance), '```');
    }
    if (m.quotes?.length) {
      lines.push('', '引用来源：');
      m.quotes.forEach((q, i) =>
        lines.push(`- [${i + 1}] 《${q.docName}》${q.pageNo ? ` 第${q.pageNo}页` : ''}：${q.snippet}`)
      );
    }
    lines.push('');
  });
  return lines.join('\n');
}

export async function shareText(title: string, text: string): Promise<string> {
  if (Platform.OS === 'web') {
    try {
      const nav: any = typeof navigator !== 'undefined' ? navigator : null;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(text);
        return '已复制到剪贴板，直接粘贴即可。';
      }
    } catch {
      // 落到下面的提示
    }
    return '当前浏览器不允许自动复制，请手动选中下方文本。';
  }
  try {
    await Share.share({ message: text, title });
    return '已打开系统分享面板（可存到文件 / 发邮件 / 发微信）。';
  } catch (e: any) {
    return `分享失败：${e?.message || '未知错误'}`;
  }
}
