// 全局状态：文档导入 / 检索 / 对话 / 合规检查 / 设置 / 锁屏
import { create } from 'zustand';
import * as DocumentPicker from 'expo-document-picker';
import { secureGet, secureSet } from './lib/secure';
import {
  Document, Conversation, Message, ModelConfig, DataStrategy,
  Attachment, ComplianceResult,
} from './types';
import {
  initDB, getDocuments, insertDocument, insertChunks, updateDocStatus,
  deleteDocument, renameDocument,
} from './lib/storage';
import { readAssetText, extToType, chunkText } from './lib/parser';
import { retrieve, buildContext, hitsToQuotes } from './lib/rag';
import { chat, ChatMsg } from './lib/llm';
import { compliancePrompt, parseCompliance } from './lib/compliance';
import { loadSettings, saveSettings, AppSettings } from './lib/settings';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 内存中保存当前解锁密码（本地 App，足够 MVP；安全存储由 secure-store 落盘）
let currentPasscode = '';

interface State {
  ready: boolean;
  documents: Document[];
  conversations: Conversation[];
  currentConvId: string | null;
  settings: AppSettings;
  importing: boolean;
  thinking: boolean;
  lastError: string | null;
  locked: boolean;
  passcodeSet: boolean;

  init: () => Promise<void>;
  importFiles: () => Promise<void>;
  removeDoc: (id: string) => Promise<void>;
  renameDoc: (id: string, name: string) => Promise<void>;
  newConversation: () => void;
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>;
  runCompliance: (text: string, attachments?: Attachment[]) => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  pickAttachments: () => Promise<Attachment[]>;
  setPasscode: (code: string) => Promise<void>;
  unlock: (code: string) => boolean;
  lock: () => void;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  documents: [],
  conversations: [],
  currentConvId: null,
  settings: {
    modelConfig: { source: 'official', provider: 'openai', baseURL: '', apiKey: '', model: 'gpt-4o-mini' },
    dataStrategy: 'local',
    privacy: { faceID: false, offlineMode: false, cloudConfirm: false },
    exportFormat: 'markdown',
  },
  importing: false,
  thinking: false,
  lastError: null,
  locked: false,
  passcodeSet: false,

  async init() {
    await initDB();
    const [docs, settings, pc] = await Promise.all([
      getDocuments(),
      loadSettings(),
      secureGet('app_passcode'),
    ]);
    currentPasscode = pc || '';
    set({
      ready: true,
      documents: docs,
      settings,
      passcodeSet: !!pc,
      locked: !!pc, // 若已设密码，则启动即锁
    });
  },

  async importFiles() {
    set({ importing: true, lastError: null });
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true, type: '*/*', copyToCacheDirectory: true,
      });
      if (res.canceled) { set({ importing: false }); return; }
      for (const a of res.assets) {
        const type = extToType(a.name);
        const doc: Document = {
          id: uid(), name: a.name, type, folderId: null, tags: [],
          status: 'indexing', meta: { size: a.size }, createdAt: new Date().toISOString(),
        };
        await insertDocument(doc);
        const text = await readAssetText(a, type);
        if (text) {
          const chunks = chunkText(text).map((c) => ({ ...c, docId: doc.id }));
          await insertChunks(chunks);
          await updateDocStatus(doc.id, 'indexed');
        } else {
          // PDF/Word 暂未接入解析引擎：标记 partial，但仍入库元数据
          await updateDocStatus(doc.id, 'partial');
        }
      }
      set({ documents: await getDocuments(), importing: false });
    } catch (e: any) {
      set({ importing: false, lastError: e?.message || '导入失败' });
    }
  },

  async removeDoc(id) {
    await deleteDocument(id);
    set({ documents: await getDocuments() });
  },

  async renameDoc(id, name) {
    await renameDocument(id, name);
    set({ documents: await getDocuments() });
  },

  newConversation() {
    const conv: Conversation = { id: uid(), messages: [] };
    set({ conversations: [conv, ...get().conversations], currentConvId: conv.id });
  },

  async sendMessage(text, attachments) {
    let convId = get().currentConvId;
    if (!convId) { get().newConversation(); convId = get().currentConvId!; }
    const conv = get().conversations.find((c) => c.id === convId)!;
    const userMsg: Message = { id: uid(), role: 'user', content: text, attachments };
    const updated = { ...conv, messages: [...conv.messages, userMsg] };
    set({ conversations: get().conversations.map((c) => (c.id === convId ? updated : c)), thinking: true, lastError: null });

    try {
      const hits = text ? await retrieve(text) : [];
      const ctx = buildContext(hits);
      const attText = (attachments || []).filter((a) => a.text).length
        ? '【本次附件文本】\n' + (attachments || []).filter((a) => a.text).map((a) => `《${a.name}》\n${a.text}`).join('\n\n')
        : '';
      const sys = `你是「技术资料 AI 助手」，只基于下方【可引用资料】与【本次附件】回答，每条结论尽量标注来源（如"见[来源1]"）。
若资料中没有明确答案，必须说明"资料未提供"，严禁编造数据或参数。`;
      const fullContext = `${sys}\n\n【可引用资料】\n${ctx}\n\n${attText}`;
      const history: ChatMsg[] = updated.messages
        .filter((m) => m.role === 'user' || m.role === 'ai')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      const messages: ChatMsg[] = [
        { role: 'system', content: fullContext },
        ...history.slice(0, -1), // 去掉刚加的 user（已放最后）
        { role: 'user', content: text },
      ];
      const aiText = await chat(get().settings.modelConfig, messages);
      const aiMsg: Message = { id: uid(), role: 'ai', content: aiText, quotes: hitsToQuotes(hits) };
      const conv2 = get().conversations.find((c) => c.id === convId)!;
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, aiMsg] } : c)),
        thinking: false,
      });
    } catch (e: any) {
      const errMsg: Message = { id: uid(), role: 'ai', content: `⚠️ ${e?.message || '请求失败'}`, quotes: [] };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, errMsg] } : c)),
        thinking: false, lastError: e?.message || '请求失败',
      });
    }
  },

  async runCompliance(text, attachments) {
    let convId = get().currentConvId;
    if (!convId) { get().newConversation(); convId = get().currentConvId!; }
    const conv = get().conversations.find((c) => c.id === convId)!;
    const userMsg: Message = { id: uid(), role: 'user', content: `【需求符合性检查】${text}`, attachments };
    set({ conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, userMsg] } : c)), thinking: true, lastError: null });

    try {
      const hits = text ? await retrieve(text) : [];
      const ctx = buildContext(hits);
      const attText = (attachments || []).filter((a) => a.text).length
        ? '【用户附件】\n' + (attachments || []).filter((a) => a.text).map((a) => `《${a.name}》\n${a.text}`).join('\n\n')
        : '';
      const prompt = compliancePrompt(text + (attText ? '\n\n' + attText : ''), ctx);
      const raw = await chat(get().settings.modelConfig, [
        { role: 'system', content: '你是树脂材料选型工程师，只输出合规检查结果 JSON。' },
        { role: 'user', content: prompt },
      ]);
      const result: ComplianceResult | null = parseCompliance(raw);
      const aiMsg: Message = result
        ? { id: uid(), role: 'ai', content: `已对要求逐项比对（详见合规卡片）。\n\n${result.conclusion}`, compliance: result }
        : { id: uid(), role: 'ai', content: `未能解析合规结果，原始返回：\n${raw}` };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, aiMsg] } : c)),
        thinking: false,
      });
    } catch (e: any) {
      const errMsg: Message = { id: uid(), role: 'ai', content: `⚠️ ${e?.message || '合规检查失败'}`, quotes: [] };
      set({
        conversations: get().conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, errMsg] } : c)),
        thinking: false, lastError: e?.message || '合规检查失败',
      });
    }
  },

  async updateSettings(patch) {
    const next: AppSettings = { ...get().settings, ...patch };
    set({ settings: next });
    await saveSettings(next);
  },

  async pickAttachments() {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, type: '*/*', copyToCacheDirectory: true });
    if (res.canceled) return [];
    const out: Attachment[] = [];
    for (const a of res.assets) {
      const isImage = (a.mimeType || '').startsWith('image/');
      let text: string | undefined;
      if (!isImage) text = (await readAssetText(a, extToType(a.name))) || undefined;
      out.push({ name: a.name, uri: a.uri, text, type: a.mimeType || (isImage ? 'image' : 'file') });
    }
    return out;
  },

  async setPasscode(code) {
    currentPasscode = code;
    await secureSet('app_passcode', code);
    set({ passcodeSet: true, locked: false });
  },

  unlock(code) {
    const ok = !!currentPasscode && code === currentPasscode;
    if (ok) set({ locked: false });
    return ok;
  },

  lock() { set({ locked: true }); },
}));
