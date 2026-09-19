import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput,
} from 'react-native';
import { colors, mono, radius, shadow, space } from '../theme';
import Button from '../components/Button';
import CaseList from '../components/CaseList';
import { useStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DocStatus, Document, DocKind } from '../types';
import { KIND_LABEL, KIND_ORDER } from '../lib/classify';

const statusMeta: Record<DocStatus, { label: string; bg: string; fg: string }> = {
  indexing: { label: '索引中', bg: colors.primarySoft, fg: colors.primary },
  indexed: { label: '已索引', bg: colors.greenSoft, fg: colors.green },
  // PDF/Word 现在真的会解析；标 partial = 没提取到文本（多半是扫描件，需 OCR）
  partial: { label: '无文本', bg: colors.amberSoft, fg: colors.amber },
  failed: { label: '失败', bg: colors.redSoft, fg: colors.red },
};

// 标签编辑面板里的常用标签建议（可自由输入，这些只是省打字）
const TAG_SUGGEST = [
  'TDS', '规格书', '检验报告',
  'Araldite', 'Huntsman',
  'CY1578', 'HY1578', 'CY5192', 'HY5192',
  'NAS',
];

const ALL = '__all__';
const PIN = '__pin__';
const UNGROUPED = '未分组';

/**
 * 分组维度。四个维度都要、由用户切 —— 它们回答的不是同一个问题：
 *   型号    查某套树脂的资料（CY1578 / HY5192 …），导入时自动认
 *   类型    做比对时想按 TDS / 规格书 / 检验报告 看，导入时自动认
 *   分类    **我自己的分类（拉挤行业 / 高压行业 …），单选、先建后选**
 *   标签    随手打的自由标签，可多个
 * ⚠️ 前三个是「一份资料一个值」的单值维度，只有标签是多值 —— 所以分组时标签取第一个。
 */
type GroupBy = 'model' | 'kind' | 'category' | 'tag';

// 标签输入统一按「、」或逗号切分（中英文逗号都认），去空去重。
// 单独抽出来是因为它有三处调用点（单份编辑 / 批量追加 / 保存），
// 三处各写一遍迟早分叉 —— 分叉的症状是「批量加标签后出现空标签」。
function splitTags(text: string): string[] {
  return Array.from(new Set(text.split(/[、,，]/).map((x) => x.trim()).filter(Boolean)));
}

function formatSize(n: number): string {
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export default function LibraryScreen() {
  // 同 ChatScreen：只订阅本屏用到的字段，别让「助手」那边的 thinking / 消息变化
  // 拖着这一屏（以及它那份可能很长的文档列表）一起重渲染。
  const {
    documents, importFiles, importing, removeDoc, renameDoc,
    settings, nasFiles, nasScanning, browseNas, openNasDoc, nasCurrent, nasPath,
    attachNasToChat, closeNasDoc, syncFromNas, lastError,
    togglePin, updateDocTags, runSearch, clearSearch,
    batchRemoveDocs, batchAddTags,
    reclassifyDoc, reclassifyMissing, updateDocClass,
    batchSetCategory, updateSettings,
    searchQuery, searchResults, searching,
    cases,
  } = useStore(
    useShallow((s) => ({
      documents: s.documents,
      importFiles: s.importFiles,
      importing: s.importing,
      removeDoc: s.removeDoc,
      renameDoc: s.renameDoc,
      settings: s.settings,
      nasFiles: s.nasFiles,
      nasScanning: s.nasScanning,
      browseNas: s.browseNas,
      openNasDoc: s.openNasDoc,
      nasCurrent: s.nasCurrent,
      nasPath: s.nasPath,
      attachNasToChat: s.attachNasToChat,
      closeNasDoc: s.closeNasDoc,
      syncFromNas: s.syncFromNas,
      lastError: s.lastError,
      togglePin: s.togglePin,
      updateDocTags: s.updateDocTags,
      batchRemoveDocs: s.batchRemoveDocs,
      reclassifyDoc: s.reclassifyDoc,
      reclassifyMissing: s.reclassifyMissing,
      updateDocClass: s.updateDocClass,
      batchAddTags: s.batchAddTags,
      batchSetCategory: s.batchSetCategory,
      updateSettings: s.updateSettings,
      runSearch: s.runSearch,
      clearSearch: s.clearSearch,
      searchQuery: s.searchQuery,
      searchResults: s.searchResults,
      searching: s.searching,
      cases: s.cases,
    }))
  );
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const mode = settings.dataStrategy;

  // 资料库 / 经验库：两件事共用「本地数据」这一层，所以合在同一屏用分段切换，
  // 而不是新占一个 Tab（底部只有 4 个位置，经验库还不配挤掉任何一个）。
  const [tab, setTab] = useState<'docs' | 'cases'>('docs');

  const [filter, setFilter] = useState<string>(ALL);
  // 分组维度：型号 / 文档类型 / 我的分类 / 自己的标签。四种都要，由用户切 —— 做比对时想按类型看，
  // 查某套树脂时想按型号看，两者不能互相替代，所以不做「自动选一个」，而是给开关。
  const [groupBy, setGroupBy] = useState<GroupBy>('model');
  const [q, setQ] = useState('');
  // 操作面板 / 标签编辑 / 重命名 的临时状态
  const [sheetDoc, setSheetDoc] = useState<Document | null>(null);
  const [tagEdit, setTagEdit] = useState<{ id: string; text: string; model: string; kind: DocKind; category: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; text: string } | null>(null);
  // 「我的分类」管理面板：新建 / 改名 / 删除 + 指定新导入默认归入哪个分类
  const [catManage, setCatManage] = useState(false);
  const [catDraft, setCatDraft] = useState('');
  const [renamingCat, setRenamingCat] = useState<{ old: string; text: string } | null>(null);
  // 批量归入分类的选择面板
  const [batchCat, setBatchCat] = useState(false);
  // 删除分类要确认：它牵动「新导入默认归入」和一批资料的归属，误删要重做归类
  const [delCat, setDelCat] = useState<string | null>(null);
  // 单个删除也要先确认：这是不可逆操作，误触的代价是整份资料要重新导入+解析。
  const [delTarget, setDelTarget] = useState<Document | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 防抖定时器必须在卸载时清掉：输完字立刻切 Tab，220ms 后仍会跑一次全库扫描并 setState。
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );

  // ---- 批量选择 ----
  // 只允许「进选择态后逐项勾选」，不提供任何形式的「一键全清空」：
  // 批量删除的破坏面太大，必须让用户对每一份文档做一次明确的勾选动作。
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchTag, setBatchTag] = useState<string | null>(null); // null = 关闭；'' = 打开且输入为空
  const [confirmBatchDel, setConfirmBatchDel] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const pinnedCount = documents.filter((d) => d.pinned).length;

  // 所有可筛选标签 = 文档标签 ∪ 型号
  const tagOptions = useMemo(() => {
    const s = new Set<string>();
    documents.forEach((d) => {
      (d.tags || []).forEach((t) => s.add(t));
      if (d.meta?.model) s.add(d.meta.model);
    });
    return Array.from(s).sort();
  }, [documents]);

  // 筛选 + 排序（钉住的排前面）
  const visibleDocs = useMemo(() => {
    let list = documents;
    if (filter === PIN) list = list.filter((d) => d.pinned);
    else if (filter !== ALL) {
      list = list.filter((d) => (d.tags || []).includes(filter) || d.meta?.model === filter);
    }
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }, [documents, filter]);

  // 按当前维度分组。四种维度的取值来源不同：
  //   型号     = meta.model（导入时自动识别）
  //   类型     = meta.kind（同上）
  //   我的分类 = meta.category（**用户自己建的，不自动猜**）
  //   标签     = 用户自己打的第一个标签
  // 拿不到值就落 UNGROUPED，并统一排在最后 —— 它该被看见（提示还有活没干），但不该挡在前面。
  // ⚠️ 分类维度**不查 categories 表**：分类被删后已归入的文档仍保留原值，
  //    用表过滤会让它们凭空消失（用户会以为资料丢了）。
  const groups = useMemo(() => {
    const keyOf = (d: Document): string => {
      if (groupBy === 'model') return d.meta?.model || UNGROUPED;
      if (groupBy === 'kind') return d.meta?.kind ? KIND_LABEL[d.meta.kind] : UNGROUPED;
      if (groupBy === 'category') return d.meta?.category || UNGROUPED;
      return (d.tags && d.tags[0]) || UNGROUPED;
    };
    const m = new Map<string, Document[]>();
    for (const d of visibleDocs) {
      const k = keyOf(d);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(d);
    }
    return Array.from(m.entries()).sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [visibleDocs, groupBy]);

  /**
   * 还没有分类的资料份数 —— 决定要不要给「补分类」入口。
   * ⚠️ 「我的分类」维度不参与：行业靠关键词猜不准，猜错比不猜更糟，
   *    所以这个维度只能由用户指派，也就无所谓「补」。
   */
  const unclassifiedCount = useMemo(() => {
    if (groupBy === 'category') return 0;
    return documents.filter((d) =>
      groupBy === 'tag' ? !(d.tags || []).length : groupBy === 'model' ? !d.meta?.model : !d.meta?.kind
    ).length;
  }, [documents, groupBy]);

  // ---- 我的分类 ----
  const categories = useMemo(() => settings.categories ?? [], [settings.categories]);
  const defaultCategory = settings.defaultCategory ?? '';
  /** 已归入各分类的份数（分类管理面板里显示，删之前让用户知道会牵动几份） */
  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    documents.forEach((d) => {
      const c = d.meta?.category;
      if (c) m.set(c, (m.get(c) || 0) + 1);
    });
    return m;
  }, [documents]);
  const uncategorizedCount = useMemo(
    () => documents.filter((d) => !d.meta?.category).length,
    [documents],
  );

  /** 新建分类。重名 / 空名直接忽略（分类名是分组的 key，出现两个一样的等于分不开） */
  const addCategory = async () => {
    const name = catDraft.trim();
    if (!name || categories.includes(name)) { setCatDraft(''); return; }
    const next = [...categories, name];
    // 第一个分类建出来就顺手设成默认：用户建它就是为了把新资料往里放
    await updateSettings({ categories: next, defaultCategory: defaultCategory || name });
    setCatDraft('');
  };

  /**
   * 删除分类。**不动已归入文档的 meta.category**（值留着，分组照旧显示这一组）——
   * 级联清空会让用户的归类工作白做一遍。要清就让用户自己批量指派。
   */
  const removeCategory = async (name: string) => {
    const next = categories.filter((c) => c !== name);
    await updateSettings({
      categories: next,
      // 默认分类指向被删的那个 → 失效，清掉（不清会让新导入归进一个看不见的分类）
      defaultCategory: defaultCategory === name ? undefined : defaultCategory,
    });
    setDelCat(null);
  };

  /**
   * 改名必须**级联改文档**：文档上存的是分类名字符串，只改表的话
   * 已归入的资料会挂着一个表里没有的旧名（分组里出现「幽灵分组」，且无法再指派）。
   */
  const renameCategory = async (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || name === oldName || categories.includes(name)) { setRenamingCat(null); return; }
    const ids = documents.filter((d) => d.meta?.category === oldName).map((d) => d.id);
    if (ids.length) await batchSetCategory(ids, name);
    await updateSettings({
      categories: categories.map((c) => (c === oldName ? name : c)),
      defaultCategory: defaultCategory === oldName ? name : defaultCategory,
    });
    setRenamingCat(null);
  };

  /** 设 / 取消「新导入默认归入」。再点一次同一个 = 取消（改成不自动归类） */
  const setDefaultCategory = async (name: string) => {
    await updateSettings({ defaultCategory: defaultCategory === name ? undefined : name });
  };

  /**
   * 单份编辑面板里的分类选项。
   * ⚠️ 要带上「文档当前挂着、但表里已经没有」的分类名（分类被删了但值还在）——
   * 不列出来的话，面板上这份资料的当前分类会凭空消失，用户会以为归类丢了。
   */
  const catOptions = useMemo(() => {
    const cur = tagEdit?.category?.trim();
    return cur && !categories.includes(cur) ? [cur, ...categories] : categories;
  }, [tagEdit, categories]);

  // ---- 批量选择：派生值与动作 ----
  const selectedDocs = useMemo(
    () => documents.filter((d) => selected.includes(d.id)),
    [documents, selected],
  );
  const allVisibleSelected = visibleDocs.length > 0 && visibleDocs.every((d) => selected.includes(d.id));
  const allPinned = selectedDocs.length > 0 && selectedDocs.every((d) => d.pinned);

  const toggleSelect = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const exitSelect = () => {
    setSelectMode(false); setSelected([]); setConfirmBatchDel(false); setBatchTag(null); setBatchCat(false);
  };

  // 全选只作用于【当前筛选结果】，不是全库 —— 否则筛完「⭐ 钉住」再点全选，
  // 会把屏幕上看不见的文档也一起选进来，接着按删除就是灾难。
  const toggleSelectAll = () => setSelected(allVisibleSelected ? [] : visibleDocs.map((d) => d.id));

  // 批量钉住让结果【一致】（全钉住 / 全取消），而不是逐个翻转 ——
  // 逐个翻转在「已钉 + 未钉」的混合选区里会把状态彻底搞乱。
  const batchPin = async () => {
    setBatchBusy(true);
    try {
      for (const d of selectedDocs) {
        if (allPinned ? d.pinned : !d.pinned) await togglePin(d.id);
      }
    } finally { setBatchBusy(false); exitSelect(); }
  };

  // 批量加标签是【追加】而非覆盖：覆盖式批量编辑会把各文档原有的标签全部清掉
  // 名字不能叫 batchAddTags —— 那是 store 里批量 action 的名字，两者会撞（本屏要同时用到）
  const applyBatchTags = async (raw: string) => {
    const add = splitTags(raw);
    if (!add.length) { setBatchTag(null); return; }
    setBatchBusy(true);
    try {
      // 同 batchDelete：一次刷新。追加语义在 store 的 batchAddTags 里（各文档原标签保留）
      await batchAddTags(selectedDocs.map((d) => d.id), add);
    } finally { setBatchBusy(false); exitSelect(); }
  };

  /** 批量归入分类。传空串 = 清成未分类。 */
  const applyBatchCategory = async (cat: string) => {
    setBatchBusy(true);
    try {
      await batchSetCategory(selectedDocs.map((d) => d.id), cat);
    } finally { setBatchBusy(false); exitSelect(); }
  };

  const batchDelete = async () => {
    setBatchBusy(true);
    try {
      // 走批量 action：删 N 份只刷新一次库。逐份调 removeDoc 的话每份都要全表重查一次
      // 并触发一整轮列表重渲染，20 份就是 20 次 —— 而且中途抛错会变成未捕获的 rejection。
      await batchRemoveDocs(selectedDocs.map((d) => d.id));
    } finally {
      // finally 而不是 try 末尾：无论删没删干净，都不能把界面留在「处理中…」
      setBatchBusy(false); exitSelect();
    }
  };

  const onSearch = (t: string) => {
    setQ(t);
    // 防抖：逐字触发全库扫描，资料多时会卡（每次都要把 chunks 全表捞出来打分）
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { void runSearch(t); }, 220);
  };

  const subText = mode === 'nas-only'
    ? `NAS 浏览 · ${nasFiles.length} 项`
    : `${documents.length} 份文档${pinnedCount ? ` · ⭐ 钉住 ${pinnedCount}` : ''}`;

  // 搜索中不给进选择态：此时列表是「搜索结果」，而全选作用于「筛选结果」，
  // 两套集合混在一起，用户看着搜索结果点全选，实际选中的是另一批 —— 接着按删除就是事故。
  const canSelect = mode !== 'nas-only' && documents.length > 0 && !q;

  // 副标题：型号 · 大小 · 解析来源与规模（"无文本"的文档也一眼看得出卡在哪）。
  // 类型不再写在这里 —— 已经提到文件名前面的 PDF/DOCX 徽章上了，重复一遍只是噪音。
  const docMetaLine = (d: Document) => {
    const m = d.meta || {};
    const parts: string[] = [];
    if (m.model) parts.push(m.model);
    // other = 没认出来，显示它等于告诉用户「我不知道」——不如不占位置
    if (m.kind && m.kind !== 'other') parts.push(KIND_LABEL[m.kind]);
    if (m.size) parts.push(formatSize(m.size));
    if (m.parseSource) {
      const src = m.parseSource === 'nas' ? 'NAS解析' : m.parseSource === 'local' ? '本地解析' : '未能提取文本';
      const sc = m.chars ? ` ${m.chars}字` : '';
      const pg = m.pages ? ` / ${m.pages}页` : '';
      parts.push(`${src}${sc}${pg}`);
    }
    return parts.join(' · ');
  };

  const renderDocCard = (d: Document) => {
    const m = statusMeta[d.status];
    const on = selected.includes(d.id);
    return (
      <Pressable
        key={d.id}
        // 选择态下点卡片 = 勾选，不再跳详情。否则一点就离开列表，没法连续勾选几份。
        onPress={() => (selectMode ? toggleSelect(d.id) : navigation.navigate('DocDetail', { docId: d.id }))}
        style={({ pressed }) => [styles.card, on && styles.cardOn, pressed && { opacity: 0.75 }]}
      >
        {selectMode && (
          <View style={[styles.check, on && styles.checkOn]}>
            {on ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <Text style={styles.ex}>{d.type.toUpperCase()}</Text>
            <Text style={styles.docName} numberOfLines={1}>
              {d.pinned ? '⭐ ' : ''}{d.name}
            </Text>
          </View>
          <Text style={styles.docMeta} numberOfLines={1}>{docMetaLine(d)}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: m.bg }]}>
          <Text style={[styles.badgeText, { color: m.fg }]}>{m.label}</Text>
        </View>
        {!selectMode && (
          <Pressable
            hitSlop={8}
            onPress={() => setSheetDoc(d)}
            style={styles.moreBtn}
          >
            <Text style={styles.moreText}>⋯</Text>
          </Pressable>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={styles.title}>{tab === 'cases' ? '经验库' : '资料库'}</Text>
          <Text style={styles.sub}>
            {/* 经验库 Tab 也不能留空 —— 顶栏空一块看着像没渲染出来，
                而且份数本身就是这一屏最该先看的信息（记了多少条经验）。 */}
            {tab === 'cases' ? `${cases.length} 条经验` : selectMode ? `已选 ${selected.length}` : subText}
          </Text>
        </View>
        {canSelect && tab === 'docs' && (
          <Pressable
            hitSlop={8}
            onPress={selectMode ? exitSelect : () => setSelectMode(true)}
            style={styles.selBtn}
          >
            <Text style={styles.selBtnText}>{selectMode ? '完成' : '选择'}</Text>
          </Pressable>
        )}
      </View>

      {/* 分段切换。切走时顺手退出选择态 —— 否则回来时会带着一批「看不见的勾选」，
          而全选/批量动作又只作用于当前列表，两边对不上。 */}
      <View style={styles.segRow}>
        {([['docs', '资料库'], ['cases', '经验库']] as const).map(([k, label]) => (
          <Pressable
            key={k}
            onPress={() => { if (k === 'cases') exitSelect(); setTab(k); }}
            style={[styles.chip, styles.segChip, tab === k && styles.chipOn]}
          >
            <Text style={[styles.chipText, tab === k && styles.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'cases' ? (
        <CaseList />
      ) : (
        <>
      {mode !== 'nas-only' && !selectMode && (
        <View style={styles.searchWrap}>
          <TextInput
            value={q}
            onChangeText={onSearch}
            placeholder="搜索资料（原文片段，不经过模型）"
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
            autoCorrect={false}
          />
          {!!q && (
            <Pressable onPress={() => { setQ(''); clearSearch(); }} hitSlop={8} style={styles.clearBtn}>
              <Text style={styles.clearText}>✕</Text>
            </Pressable>
          )}
        </View>
      )}

      {mode !== 'nas-only' && !!q && !selectMode ? (
        // ---------- 搜索结果：直接看命中的原文片段 ----------
        <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
          <Text style={styles.resultHint}>
            {searching ? '搜索中…' : `找到 ${searchResults.length} 条（文件名命中的排前面）`}
          </Text>
          {searchResults.map((r, i) => (
            <Pressable
              key={`${r.docId}-${i}`}
              onPress={() => navigation.navigate('DocDetail', { docId: r.docId })}
              style={({ pressed }) => [styles.resultCard, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.resultHead} numberOfLines={1}>
                {r.kind === 'doc' ? '📄 ' : '🔎 '}{r.docName}
                {r.pageNo ? <Text style={styles.resultPage}>{`  第${r.pageNo}页`}</Text> : null}
              </Text>
              <Text style={styles.resultBody} numberOfLines={4}>{r.snippet}</Text>
            </Pressable>
          ))}
          {!searching && searchResults.length === 0 && (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>没有命中。</Text>
              <Text style={styles.emptyHint}>
                换关键词试试（多个词用空格分隔）。若这份资料是扫描件（整页图片、没有文字层），
                正文提不出来，所以搜不到 —— 那类需要 OCR，目前还没做。
              </Text>
            </View>
          )}
        </ScrollView>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
          {mode === 'nas-only' ? (
            <>
              {nasFiles.length === 0 && (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>纯 NAS 模式：资料存在你的 NAS 上。</Text>
                  <Text style={styles.emptyHint}>点下方「浏览 NAS」拉取文件列表；点文件即从 NAS 读取（需联网，不占手机空间）。</Text>
                </View>
              )}
              {/* 面包屑 + 返回上级：进了子目录必须知道自己在哪、能退回去。
                  只要不在根目录就显示 —— 根目录显示「NAS /」纯属占地方。 */}
              {nasPath !== '' && (
                <View style={styles.nasPathRow}>
                  <Pressable hitSlop={6} onPress={() => void browseNas()} style={styles.nasUp}>
                    <Text style={styles.nasUpT}>← 返回上级</Text>
                  </Pressable>
                  <Text style={styles.nasPathText} numberOfLines={1}>
                    NAS / {nasPath.split('/').filter(Boolean).join(' / ')}
                  </Text>
                </View>
              )}
              {nasFiles.map((f) => (
                <Pressable
                  key={f.href}
                  // 文件夹要能进：以前点它直接 return，看着像点了没反应（列表里画着 📁，
                  // 用户自然会以为能点开）。现在进一层；文件才是打开阅读。
                  onPress={() => (f.isDir ? void browseNas(f.name) : void openNasDoc(f))}
                  disabled={nasScanning}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.docName} numberOfLines={1}>{f.isDir ? '📁 ' : '📄 '}{f.name}</Text>
                    <Text style={styles.docMeta}>{f.isDir ? '文件夹 · 点开进入' : `NAS · ${formatSize(f.size)}`}</Text>
                  </View>
                  {f.isDir ? <Text style={styles.nasChevron}>›</Text> : null}
                </Pressable>
              ))}
            </>
          ) : (
            <>
              {/* 分组维度：型号 / 类型 / 我的分类 / 标签 四种都留着，用户自己切当前看哪个。
                  右边的小按钮按维度变：
                    · 型号 / 类型 → 「补分类 N」：早先导入的资料没有这两个字段，会一直挂未分组，
                      与其让用户猜，不如把「还有 N 份没分」直接摆出来并给一键补。
                    · 我的分类 → 「管理分类」：这个维度只能由用户自己建，所以给的是入口不是补。 */}
              {documents.length > 0 && (
                <View style={styles.groupByRow}>
                  <Text style={styles.groupByLabel}>分组</Text>
                  {([['model', '型号'], ['kind', '类型'], ['category', '分类'], ['tag', '标签']] as const).map(([k, label]) => (
                    <Pressable
                      key={k}
                      onPress={() => setGroupBy(k)}
                      style={[styles.chip, groupBy === k && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, groupBy === k && styles.chipTextOn]}>{label}</Text>
                    </Pressable>
                  ))}
                  {unclassifiedCount > 0 && (
                    <Pressable
                      hitSlop={6}
                      onPress={() => void reclassifyMissing()}
                      style={styles.miniBtn}
                    >
                      <Text style={styles.miniBtnT}>补分类 {unclassifiedCount}</Text>
                    </Pressable>
                  )}
                  {groupBy === 'category' && (
                    <Pressable hitSlop={6} onPress={() => setCatManage(true)} style={styles.miniBtn}>
                      <Text style={styles.miniBtnT}>{categories.length ? '管理分类' : '＋ 新建分类'}</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {/* 筛选条：全部 / 钉住 / 各标签 */}
              {documents.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.chipsRow}
                  contentContainerStyle={styles.chipsInner}
                >
                  {[{ k: ALL, label: '全部' }, { k: PIN, label: `⭐ 钉住${pinnedCount ? ` ${pinnedCount}` : ''}` }]
                    .concat(tagOptions.map((t) => ({ k: t, label: t })))
                    .map((c) => (
                      <Pressable
                        key={c.k}
                        onPress={() => setFilter(c.k)}
                        style={[styles.chip, filter === c.k && styles.chipOn]}
                      >
                        <Text style={[styles.chipText, filter === c.k && styles.chipTextOn]}>{c.label}</Text>
                      </Pressable>
                    ))}
                </ScrollView>
              )}

              {documents.length === 0 && (
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>还没有资料。点下方「导入文档」开始。</Text>
                  <Text style={styles.emptyHint}>
                    支持 PDF / Word / Markdown / TXT，导入时就解析入库，可直接被搜索与问答引用。
                    扫描件（整页图片的 PDF）暂时提不出文字，会标成「无文本」。
                  </Text>
                </View>
              )}

              {filter === PIN && visibleDocs.length === 0 && (
                <View style={styles.empty}>
                  <Text style={styles.emptyHint}>还没钉住任何文档。点文档右侧「⋯ → 钉住」，之后每次问答都会自动带上它。</Text>
                </View>
              )}

              {groups.map(([tag, docs]) => (
                <View key={tag} style={{ marginBottom: space.s2 }}>
                  <Text style={styles.groupHead}>{tag === UNGROUPED ? '未分组' : tag} · {docs.length}</Text>
                  {docs.map(renderDocCard)}
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}

      <View style={styles.action}>
        {selectMode ? (
          <>
            <View style={styles.batchRow}>
              <Button
                label={allVisibleSelected ? '取消全选' : '全选当前'}
                variant="ghost"
                onPress={toggleSelectAll}
                disabled={!visibleDocs.length || batchBusy}
                style={{ flex: 1 }}
              />
              <Button
                // 还没建分类时不该是个死按钮（点了没反应 = 又一个空壳开关）→ 直接送去建分类
                label="归入分类"
                variant="soft"
                onPress={() => (categories.length ? setBatchCat(true) : setCatManage(true))}
                disabled={!selected.length || batchBusy}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
            <View style={[styles.batchRow, { marginTop: space.s2 }]}>
              <Button
                label="加标签"
                variant="soft"
                onPress={() => setBatchTag('')}
                disabled={!selected.length || batchBusy}
                style={{ flex: 1 }}
              />
              <Button
                label={allPinned ? '取消钉住' : '⭐ 钉住'}
                variant="soft"
                onPress={batchPin}
                disabled={!selected.length || batchBusy}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
            <View style={{ marginTop: space.s2 }}>
              <Button
                label={batchBusy ? '处理中…' : `删除${selected.length ? ` ${selected.length}` : ''}`}
                variant="danger"
                onPress={() => setConfirmBatchDel(true)}
                disabled={!selected.length || batchBusy}
              />
            </View>
            <Text style={styles.batchHint}>
              已选 {selected.length} 份 · 全选只作用于当前筛选结果
            </Text>
          </>
        ) : mode === 'nas-only' ? (
          <Button label={nasScanning ? '读取中…' : '浏览 NAS'} onPress={browseNas} disabled={nasScanning} />
        ) : (
          <>
            {mode === 'local+sync' && (
              <Button
                label={importing ? '同步中…' : '从 NAS 同步'}
                variant="soft"
                onPress={syncFromNas}
                disabled={importing}
                style={{ marginBottom: space.s2 }}
              />
            )}
            <Button label={importing ? '导入中…' : '＋ 导入文档'} onPress={importFiles} disabled={importing} />
          </>
        )}
        {lastError ? <Text style={styles.errText} numberOfLines={2}>{lastError}</Text> : null}
      </View>

      {/* ---------- 文档操作面板 ---------- */}
      {sheetDoc && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setSheetDoc(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>{sheetDoc.name}</Text>
            <ActionRow
              label={sheetDoc.pinned ? '取消钉住' : '⭐ 钉住（每次问答自动带上）'}
              onPress={() => { void togglePin(sheetDoc.id); setSheetDoc(null); }}
            />
            <ActionRow
              label="分类与标签"
              onPress={() => {
                setTagEdit({
                  id: sheetDoc.id,
                  text: (sheetDoc.tags || []).join('、'),
                  model: sheetDoc.meta?.model || '',
                  kind: sheetDoc.meta?.kind || 'other',
                  category: sheetDoc.meta?.category || '',
                });
                setSheetDoc(null);
              }}
            />
            <ActionRow
              label="重新识别分类"
              onPress={() => { void reclassifyDoc(sheetDoc.id); setSheetDoc(null); }}
            />
            <ActionRow
              label="重命名"
              onPress={() => { setRenameTarget({ id: sheetDoc.id, text: sheetDoc.name }); setSheetDoc(null); }}
            />
            <ActionRow
              label="查看详情"
              onPress={() => { const id = sheetDoc.id; setSheetDoc(null); navigation.navigate('DocDetail', { docId: id }); }}
            />
            <ActionRow
              label="删除"
              danger
              onPress={() => { setDelTarget(sheetDoc); setSheetDoc(null); }}
            />
            <Button label="取消" variant="ghost" onPress={() => setSheetDoc(null)} style={{ marginTop: space.s2 }} />
          </View>
        </View>
      )}

      {/* ---------- 分类与标签编辑面板 ---------- */}
      {tagEdit && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setTagEdit(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>分类与标签</Text>
            <Text style={styles.fieldHint}>型号与类型在导入时自动认，认错或没认出来就在这里改。分类是你自己建的，一份资料只归一个。</Text>

            <Text style={styles.fieldLabel}>我的分类</Text>
            {catOptions.length ? (
              <View style={styles.kindRow}>
                <Pressable
                  onPress={() => setTagEdit({ ...tagEdit, category: '' })}
                  style={[styles.chip, !tagEdit.category && styles.chipOn]}
                >
                  <Text style={[styles.chipText, !tagEdit.category && styles.chipTextOn]}>未分类</Text>
                </Pressable>
                {catOptions.map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setTagEdit({ ...tagEdit, category: c })}
                    style={[styles.chip, tagEdit.category === c && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, tagEdit.category === c && styles.chipTextOn]}>{c}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Pressable
                onPress={() => { setTagEdit(null); setCatManage(true); }}
                style={[styles.miniBtn, { alignSelf: 'flex-start' }]}
              >
                <Text style={styles.miniBtnT}>＋ 新建分类（如：拉挤行业）</Text>
              </Pressable>
            )}

            <Text style={styles.fieldLabel}>型号</Text>
            <TextInput
              value={tagEdit.model}
              onChangeText={(t) => setTagEdit({ ...tagEdit, model: t })}
              placeholder="例如：CY1578"
              placeholderTextColor={colors.muted}
              style={styles.field}
              autoCorrect={false}
            />

            <Text style={styles.fieldLabel}>文档类型</Text>
            <View style={styles.kindRow}>
              {KIND_ORDER.map((k) => (
                <Pressable
                  key={k}
                  onPress={() => setTagEdit({ ...tagEdit, kind: k })}
                  style={[styles.chip, tagEdit.kind === k && styles.chipOn]}
                >
                  <Text style={[styles.chipText, tagEdit.kind === k && styles.chipTextOn]}>
                    {KIND_LABEL[k]}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.fieldLabel}>标签</Text>
            <Text style={styles.fieldHint}>多个标签用「、」或逗号分隔。按「标签」分组时，第一个标签就是它所在的分组。</Text>
            <TextInput
              value={tagEdit.text}
              onChangeText={(t) => setTagEdit({ ...tagEdit, text: t })}
              placeholder="例如：Araldite、CY1578、TDS"
              placeholderTextColor={colors.muted}
              style={styles.field}
              autoCorrect={false}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.s2 }}>
              <View style={styles.chipsInner}>
                {TAG_SUGGEST.map((t) => {
                  // 用 splitTags 判存在，而不是 text.includes(t)：
                  // 后者会让「TDS报告」把标签 TDS 误显示成已选中，一点反而把它删掉。
                  const has = splitTags(tagEdit.text).includes(t);
                  return (
                    <Pressable
                      key={t}
                      onPress={() => {
                        const parts = splitTags(tagEdit.text);
                        const next = has ? parts.filter((x) => x !== t) : [...parts, t];
                        setTagEdit({ ...tagEdit, text: next.join('、') });
                      }}
                      style={[styles.chip, has && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, has && styles.chipTextOn]}>{has ? `✓ ${t}` : `＋ ${t}`}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setTagEdit(null)} style={{ flex: 1 }} />
              <Button
                label="保存"
                onPress={() => {
                  void (async () => {
                    await updateDocTags(tagEdit.id, splitTags(tagEdit.text));
                    await updateDocClass(tagEdit.id, { model: tagEdit.model, kind: tagEdit.kind, category: tagEdit.category });
                  })();
                  setTagEdit(null);
                }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 我的分类：新建 / 改名 / 删除 / 设默认 ---------- */}
      {catManage && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setCatManage(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>我的分类</Text>
            <Text style={styles.fieldHint}>
              建好之后，导入的资料可以直接归进来；问答时也能只查某一个分类 —— 两个行业的参数不会混在一起回答。
            </Text>

            {categories.length === 0 && (
              <Text style={styles.fieldHint}>还没有分类。先建一个，比如「拉挤行业」。</Text>
            )}

            {categories.map((c) => (
              <View key={c} style={styles.catRow}>
                <Pressable style={{ flex: 1 }} onPress={() => void setDefaultCategory(c)}>
                  <Text style={styles.catName}>
                    {defaultCategory === c ? '● ' : '○ '}{c}
                    <Text style={styles.catCount}> · {catCounts.get(c) || 0} 份</Text>
                  </Text>
                </Pressable>
                <Pressable hitSlop={6} onPress={() => setRenamingCat({ old: c, text: c })}>
                  <Text style={styles.miniBtnT}>改名</Text>
                </Pressable>
                <Pressable hitSlop={6} onPress={() => setDelCat(c)}>
                  <Text style={[styles.miniBtnT, { color: colors.red }]}>删除</Text>
                </Pressable>
              </View>
            ))}

            {categories.length > 0 && (
              <Text style={styles.fieldHint}>
                点左边的小圆点 = 设为「新导入默认归入」，再点一次取消。当前：{defaultCategory || '不自动归类'}。
                {uncategorizedCount > 0 ? ` 还有 ${uncategorizedCount} 份未归类（可多选后点「归入分类」）。` : ''}
              </Text>
            )}

            <Text style={styles.fieldLabel}>新建分类</Text>
            <TextInput
              value={catDraft}
              onChangeText={setCatDraft}
              placeholder="例如：拉挤行业"
              placeholderTextColor={colors.muted}
              style={styles.field}
              autoCorrect={false}
              onSubmitEditing={() => void addCategory()}
            />
            <View style={styles.sheetBtns}>
              <Button label="关闭" variant="ghost" onPress={() => setCatManage(false)} style={{ flex: 1 }} />
              <Button
                label="＋ 添加"
                onPress={() => void addCategory()}
                disabled={!catDraft.trim() || categories.includes(catDraft.trim())}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 分类改名（要级联改已归入的资料）---------- */}
      {renamingCat && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setRenamingCat(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>重命名分类</Text>
            <TextInput
              value={renamingCat.text}
              onChangeText={(t) => setRenamingCat({ ...renamingCat, text: t })}
              placeholder="分类名"
              placeholderTextColor={colors.muted}
              style={styles.field}
              autoFocus
              autoCorrect={false}
              onSubmitEditing={() => void renameCategory(renamingCat.old, renamingCat.text)}
            />
            <Text style={styles.fieldHint}>
              已归入这个分类的 {catCounts.get(renamingCat.old) || 0} 份资料会一起改过来 ——
              只改分类名不改资料的话，它们会挂着一个表里没有的旧名，之后就没法再指派了。
            </Text>
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setRenamingCat(null)} style={{ flex: 1 }} />
              <Button
                label="保存"
                onPress={() => void renameCategory(renamingCat.old, renamingCat.text)}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 删除分类确认 ---------- */}
      {delCat && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setDelCat(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>删除分类「{delCat}」？</Text>
            <Text style={styles.fieldHint}>
              {catCounts.get(delCat) || 0} 份资料已归入这个分类。删除分类**不会**清掉它们的归属 ——
              这些资料仍会作为一组显示在资料库里，你可以再多选它们、指派到别的分类。
            </Text>
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setDelCat(null)} style={{ flex: 1 }} />
              <Button
                label="删除分类"
                variant="danger"
                onPress={() => void removeCategory(delCat)}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 批量归入分类 ---------- */}
      {batchCat && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setBatchCat(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>把这 {selectedDocs.length} 份归入</Text>
            <Text style={styles.fieldHint}>一份资料只归一个分类，所以这里是「设为」而不是「追加」。</Text>
            {categories.map((c) => (
              <ActionRow key={c} label={c} onPress={() => void applyBatchCategory(c)} />
            ))}
            <ActionRow label="未分类（清掉归类）" onPress={() => void applyBatchCategory('')} danger />
            <Button label="取消" variant="ghost" onPress={() => setBatchCat(false)} style={{ marginTop: space.s2 }} />
          </View>
        </View>
      )}

      {/* ---------- 重命名面板 ---------- */}
      {renameTarget && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setRenameTarget(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>重命名文档</Text>
            <TextInput
              value={renameTarget.text}
              onChangeText={(t) => setRenameTarget({ ...renameTarget, text: t })}
              style={styles.field}
              autoFocus
              autoCorrect={false}
            />
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setRenameTarget(null)} style={{ flex: 1 }} />
              <Button
                label="保存"
                onPress={() => {
                  const t = renameTarget.text.trim();
                  if (t) void renameDoc(renameTarget.id, t);
                  setRenameTarget(null);
                }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 删除确认（单份）---------- */}
      {delTarget && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setDelTarget(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>删除这份资料？</Text>
            <Text style={styles.fieldHint} numberOfLines={3}>{delTarget.name}</Text>
            <Text style={styles.warnText}>
              文档、已提取的正文、向量索引会一起删掉，无法撤销 —— 要恢复只能重新导入并解析一次。
            </Text>
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setDelTarget(null)} style={{ flex: 1 }} />
              <Button
                label="确认删除"
                variant="danger"
                onPress={() => { const id = delTarget.id; setDelTarget(null); void removeDoc(id); }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 批量删除确认 ---------- */}
      {/* 逐份列出将删除的文件名：批量删除最危险的失败模式是「选多了却不知道多了谁」，
          只报个数等于把核对成本推给用户。有名单就能一眼看出多勾了哪份。 */}
      {confirmBatchDel && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setConfirmBatchDel(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>删除这 {selectedDocs.length} 份资料？</Text>
            <ScrollView style={styles.sheetBody}>
              {selectedDocs.map((d) => (
                <Text key={d.id} style={styles.delItem} numberOfLines={1}>· {d.name}</Text>
              ))}
            </ScrollView>
            <Text style={styles.warnText}>
              以上 {selectedDocs.length} 份的正文与索引会一起删掉，无法撤销。
              若其中有不想删的，先「返回勾选」把它取消掉。
            </Text>
            <View style={styles.sheetBtns}>
              <Button
                label="返回勾选"
                variant="ghost"
                onPress={() => setConfirmBatchDel(false)}
                disabled={batchBusy}
                style={{ flex: 1 }}
              />
              <Button
                label={batchBusy ? '删除中…' : `确认删除 ${selectedDocs.length} 份`}
                variant="danger"
                onPress={batchDelete}
                disabled={batchBusy}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {/* ---------- 批量加标签 ---------- */}
      {batchTag !== null && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setBatchTag(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>给 {selectedDocs.length} 份加标签</Text>
            <Text style={styles.fieldHint}>
              追加式：各文档原有的标签会保留。多个标签用「、」或逗号分隔。
            </Text>
            <TextInput
              value={batchTag}
              onChangeText={setBatchTag}
              placeholder="例如：Araldite、CY1578"
              placeholderTextColor={colors.muted}
              style={styles.field}
              autoFocus
              autoCorrect={false}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.s2 }}>
              <View style={styles.chipsInner}>
                {TAG_SUGGEST.map((t) => {
                  const has = splitTags(batchTag).includes(t);
                  return (
                    <Pressable
                      key={t}
                      onPress={() => {
                        const parts = splitTags(batchTag);
                        const next = has ? parts.filter((x) => x !== t) : [...parts, t];
                        setBatchTag(next.join('、'));
                      }}
                      style={[styles.chip, has && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, has && styles.chipTextOn]}>{has ? `✓ ${t}` : `＋ ${t}`}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
            <View style={styles.sheetBtns}>
              <Button label="取消" variant="ghost" onPress={() => setBatchTag(null)} style={{ flex: 1 }} />
              <Button
                label={batchBusy ? '处理中…' : '加进去'}
                onPress={() => void applyBatchTags(batchTag)}
                disabled={batchBusy || !splitTags(batchTag).length}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}

      {nasCurrent && (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>📄 {nasCurrent.name}</Text>
            <ScrollView style={styles.sheetBody}>
              <Text style={styles.sheetText}>{nasCurrent.text.slice(0, 4000) || '（空文件）'}</Text>
            </ScrollView>
            <View style={styles.sheetBtns}>
              <Button label="关闭" variant="ghost" onPress={closeNasDoc} style={{ flex: 1 }} />
              <Button
                label="带入对话"
                onPress={() => { attachNasToChat(); navigation.navigate('Chat'); }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
          </View>
        </View>
      )}
        </>
      )}
    </View>
  );
}

function ActionRow({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.actionRowText, danger && { color: colors.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  head: {
    paddingHorizontal: space.s3, paddingTop: space.s0, paddingBottom: space.s2,
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
  },
  headLeft: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-end', gap: space.s2 },
  // 进入批量选择的入口做成文字按钮而不是图标：图标在这个项目里没有图标库可依赖（零新增依赖），
  // 文字「选择 / 完成」也自带状态说明，不用额外解释。
  selBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 2,
  },
  selBtnText: { fontSize: 12.5, fontWeight: '600', color: colors.primary },
  title: { fontSize: 26, fontWeight: '700', color: colors.text, letterSpacing: -0.8 },
  sub: { fontFamily: mono, fontSize: 11, color: colors.muted, paddingBottom: 4 },
  searchWrap: { paddingHorizontal: space.s3, paddingBottom: space.s2, position: 'relative' },
  searchInput: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    paddingHorizontal: space.s3, paddingVertical: 11,
    fontSize: 13.5, color: colors.text, paddingRight: 34,
    ...shadow.card,
  },
  clearBtn: { position: 'absolute', right: space.s3 + 8, top: 9 },
  clearText: { fontSize: 15, color: colors.muted },
  list: { flex: 1 },
  listInner: { paddingHorizontal: space.s3, paddingBottom: space.s2 },
  groupByRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: space.s2 },
  groupByLabel: { fontSize: 12, color: colors.muted, fontWeight: '700' },
  miniBtn: {
    marginLeft: 'auto', paddingVertical: 4, paddingHorizontal: 10,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.primarySoft,
  },
  miniBtnT: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  fieldLabel: { fontSize: 12.5, fontWeight: '700', color: colors.text, marginTop: space.s2, marginBottom: 6 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: space.s2 },
  chipsRow: { marginBottom: space.s2, flexGrow: 0 },
  chipsInner: { flexDirection: 'row', gap: 8, paddingRight: space.s3 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  chipText: { fontSize: 12.5, color: colors.muted, fontWeight: '600' },
  chipTextOn: { color: colors.primary },
  // 分段切换：两个等宽 chip 铺满一行。等宽是为了「选中态移动」时位置稳定，不随字数抖动。
  segRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: space.s3, paddingBottom: space.s2,
  },
  segChip: { flex: 1, alignItems: 'center', paddingVertical: 7 },
  groupHead: {
    fontFamily: mono, fontSize: 10, letterSpacing: 1.4, color: colors.muted,
    textTransform: 'uppercase', marginBottom: 8, marginTop: 10, marginHorizontal: 2,
  },
  empty: { paddingVertical: space.s4, alignItems: 'center' },
  emptyText: { fontSize: 14, color: colors.text, marginBottom: 6 },
  emptyHint: { fontSize: 12, color: colors.muted, textAlign: 'center', paddingHorizontal: space.s4, lineHeight: 19 },
  // NAS 面包屑行：进了子目录后要知道自己在哪、怎么退回去
  nasPathRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.s2,
    marginBottom: space.s2, paddingHorizontal: 2,
  },
  nasUp: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.card,
  },
  nasUpT: { fontSize: 11.5, color: colors.text, fontFamily: mono },
  nasPathText: { flex: 1, fontFamily: mono, fontSize: 10.5, color: colors.muted },
  nasChevron: { fontSize: 20, color: colors.faint, paddingHorizontal: 2 },
  card: {
    backgroundColor: colors.card, borderRadius: radius.xl,
    paddingHorizontal: space.s2 + 2, paddingVertical: space.s2, marginBottom: space.s1 + 2,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    // 边框常驻（未选中时透明）：只在选中时加 borderWidth 会让卡片上下各跳 1px，
    // 勾选几份时整列表会跳来跳去。
    borderWidth: 1, borderColor: 'transparent',
    ...shadow.card,
  },
  cardOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  // 勾选圈用 View 画（同 TabGlyph 的理由：不引图标库，原生与 web 表现一致）
  check: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1.5,
    borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { fontSize: 12, lineHeight: 14, fontWeight: '700', color: '#fff' },
  batchRow: { flexDirection: 'row' },
  batchHint: { fontFamily: mono, fontSize: 10.5, color: colors.muted, marginTop: space.s2, textAlign: 'center' },
  // 分类管理里的一行：●/○ 默认标记 + 分类名 + 份数，右侧改名 / 删除
  catRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  catName: { fontSize: 13.5, fontWeight: '600', color: colors.text },
  catCount: { fontFamily: mono, fontSize: 10.5, fontWeight: '400', color: colors.muted },
  warnText: { fontSize: 12, color: colors.red, lineHeight: 18, marginBottom: space.s2 },
  delItem: { fontSize: 12.5, color: colors.text, lineHeight: 19 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // 类型徽章提到名字前面：一眼分清 TDS 和规格书，不用去读文件名后缀
  ex: {
    fontFamily: mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, color: colors.primary,
    backgroundColor: colors.primarySoft, borderRadius: 6, paddingVertical: 4, width: 34, textAlign: 'center', overflow: 'hidden',
  },
  docName: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: colors.text },
  docMeta: { fontFamily: mono, fontSize: 9.5, color: colors.faint, marginTop: 3, marginLeft: 42 },
  badge: { borderRadius: 9, paddingVertical: 5, paddingHorizontal: 9 },
  badgeText: { fontFamily: mono, fontSize: 10, fontWeight: '700' },
  moreBtn: { paddingHorizontal: 8, paddingVertical: 2, marginLeft: 2 },
  moreText: { fontSize: 18, color: colors.muted, lineHeight: 20 },
  resultHint: { fontFamily: mono, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.muted, marginBottom: space.s2, marginHorizontal: 2 },
  resultCard: {
    backgroundColor: colors.card, borderRadius: radius.xl,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: space.s1 + 2,
    ...shadow.card,
  },
  resultHead: { fontSize: 12.5, color: colors.text, fontWeight: '600', marginBottom: 5 },
  resultPage: { fontFamily: mono, fontSize: 10, color: colors.faint, fontWeight: '400' },
  resultBody: { fontSize: 12, color: colors.muted, lineHeight: 18 },
  action: { padding: space.s3, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  errText: { fontSize: 12, color: colors.red, marginTop: space.s2 },
  overlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, padding: space.s3, maxHeight: '80%' },
  sheetTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  sheetBody: { maxHeight: 320, marginBottom: space.s2 },
  sheetText: { fontSize: 13, color: colors.text, lineHeight: 20 },
  sheetBtns: { flexDirection: 'row' },
  actionRow: { paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.border },
  actionRowText: { fontSize: 15, color: colors.text },
  fieldHint: { fontSize: 12, color: colors.muted, marginBottom: space.s2, lineHeight: 18 },
  field: {
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.sm, paddingHorizontal: space.s3, paddingVertical: 10,
    fontSize: 14, color: colors.text, marginBottom: space.s2,
  },
});
