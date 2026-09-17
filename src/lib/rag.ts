// RAG 检索封装：MVP 用 SQLite 全文关键词检索，向量检索后置
import { searchChunks } from './storage';

export interface Hit {
  docId: string;
  docName: string;
  content: string;
  pageNo?: number;
  score: number;
}

// 给定查询，返回本地资料库中最相关的文本片段
export async function retrieve(query: string, limit = 8): Promise<Hit[]> {
  return (await searchChunks(query, limit)) as Hit[];
}

// 把检索结果拼成带编号的上下文，供 LLM 引用
export function buildContext(hits: Hit[]): string {
  if (hits.length === 0) return '（资料库暂无相关内容）';
  return hits
    .map(
      (h, i) =>
        `[来源${i + 1}] 《${h.docName}》${h.pageNo ? `第${h.pageNo}页` : ''}\n${h.content}`
    )
    .join('\n\n');
}

// 把命中转成引用卡
export function hitsToQuotes(hits: Hit[]) {
  return hits.map((h) => ({
    docId: h.docId,
    docName: h.docName,
    pageNo: h.pageNo,
    snippet: h.content.slice(0, 160),
  }));
}
