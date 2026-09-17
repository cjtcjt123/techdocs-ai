// 解析纯函数（与平台无关）—— 原生 parser.ts 与 web parser.web.ts 共用，避免逻辑分叉
import { Chunk, DocType } from '../types';

export function extToType(name: string): DocType {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'txt';
}

// 切块：按空行分段，超长段落再切 800 字
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  let seq = 0;
  for (const p of paras) {
    if (p.length > 800) {
      for (let i = 0; i < p.length; i += 800) {
        chunks.push({
          id: `${seq}`, docId: '', seq: seq++,
          content: p.slice(i, i + 800), ctype: 'para',
        });
      }
    } else {
      chunks.push({ id: `${seq}`, docId: '', seq: seq++, content: p, ctype: 'para' });
    }
  }
  return chunks;
}
