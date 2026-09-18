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
