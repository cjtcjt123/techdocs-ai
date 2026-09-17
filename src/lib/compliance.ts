// 需求符合性检查：把"技术要求/工况"与资料库 + 附件比对，输出三态判定
import { ComplianceResult } from '../types';

// 构建符合性检查提示词（要求来源：用户输入 + 可选资料上下文）
export function compliancePrompt(requirement: string, libraryContext: string): string {
  return `你是一名严谨的树脂材料选型工程师。
下面是用户给出的「技术要求 / 工况要求」，以及资料库中可能相关的树脂 TDS 片段。
请从中找出最匹配的一款树脂体系，并逐项核对要求，给出三态判定。

判定规则：
- verdict 只能是 "ok"（满足）/ "no"（不满足或超标）/ "warn"（差一点 / 临界 / 资料不足）
- 每项给出 required（要求值）、actual（资料中实际值）、source（来源文档名 + 页码；若来自用户附件写「附件：文件名」）
- 实际值找不到时，actual 写「资料未提供」，verdict 写 "warn"
- 最后用 conclusion 给出综合结论与选型建议（哪款合适 / 差在哪里）

技术要求：
${requirement}

可选资料：
${libraryContext}

请严格只输出 JSON（不要 markdown 代码块、不要多余文字）：
{"model":"匹配到的树脂体系名","items":[{"item":"指标名","required":"要求","actual":"实际","verdict":"ok|no|warn","source":"来源"}],"conclusion":"综合结论与建议"}`;
}

// 解析模型返回，容忍前后多余文字，提取 JSON
export function parseCompliance(text: string): ComplianceResult | null {
  if (!text) return null;
  let s = text.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(s);
    if (obj && Array.isArray(obj.items)) {
      return {
        model: String(obj.model || '未知'),
        items: obj.items.map((it: any) => ({
          item: String(it.item || ''),
          required: String(it.required || ''),
          actual: String(it.actual || ''),
          verdict: ['ok', 'no', 'warn'].includes(it.verdict) ? it.verdict : 'warn',
          source: it.source ? String(it.source) : undefined,
        })),
        conclusion: String(obj.conclusion || ''),
      };
    }
  } catch {
    return null;
  }
  return null;
}
