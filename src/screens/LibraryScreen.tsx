import React, { useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput,
} from 'react-native';
import { colors, mono, radius, shadow, space } from '../theme';
import Button from '../components/Button';
import { useStore } from '../store';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DocStatus, Document } from '../types';

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

function formatSize(n: number): string {
  if (!n) return '';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export default function LibraryScreen() {
  const {
    documents, importFiles, importing, removeDoc, renameDoc,
    settings, nasFiles, nasScanning, browseNas, openNasDoc, nasCurrent,
    attachNasToChat, closeNasDoc, syncFromNas, lastError,
    togglePin, updateDocTags, runSearch, clearSearch,
    searchQuery, searchResults, searching,
  } = useStore();
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const mode = settings.dataStrategy;

  const [filter, setFilter] = useState<string>(ALL);
  const [q, setQ] = useState('');
  // 操作面板 / 标签编辑 / 重命名 的临时状态
  const [sheetDoc, setSheetDoc] = useState<Document | null>(null);
  const [tagEdit, setTagEdit] = useState<{ id: string; text: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; text: string } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // 按标签（无标签则按型号）分组
  const groups = useMemo(() => {
    const m = new Map<string, Document[]>();
    for (const d of visibleDocs) {
      const k = (d.tags && d.tags[0]) || d.meta?.model || UNGROUPED;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(d);
    }
    return Array.from(m.entries()).sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [visibleDocs]);

  const onSearch = (t: string) => {
    setQ(t);
    // 防抖：逐字触发全库扫描，资料多时会卡（每次都要把 chunks 全表捞出来打分）
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { void runSearch(t); }, 220);
  };

  const subText = mode === 'nas-only'
    ? `NAS 浏览 · ${nasFiles.length} 项`
    : `${documents.length} 份文档${pinnedCount ? ` · ⭐ 钉住 ${pinnedCount}` : ''}`;

  // 副标题：型号 · 大小 · 解析来源与规模（"无文本"的文档也一眼看得出卡在哪）。
  // 类型不再写在这里 —— 已经提到文件名前面的 PDF/DOCX 徽章上了，重复一遍只是噪音。
  const docMetaLine = (d: Document) => {
    const m = d.meta || {};
    const parts: string[] = [];
    if (m.model) parts.push(m.model);
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
    return (
      <Pressable
        key={d.id}
        onPress={() => navigation.navigate('DocDetail', { docId: d.id })}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}
      >
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
        <Pressable
          hitSlop={8}
          onPress={() => setSheetDoc(d)}
          style={styles.moreBtn}
        >
          <Text style={styles.moreText}>⋯</Text>
        </Pressable>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <Text style={styles.title}>资料库</Text>
        <Text style={styles.sub}>{subText}</Text>
      </View>

      {mode !== 'nas-only' && (
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

      {mode !== 'nas-only' && !!q ? (
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
                换关键词试试（多个词用空格分隔）。注意：PDF / Word 目前只入库了文件名、正文还没解析，
                所以搜不到里面的内容——这是下一批要补的。
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
              {nasFiles.map((f) => (
                <Pressable
                  key={f.href}
                  onPress={() => { if (!f.isDir) openNasDoc(f); }}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.docName} numberOfLines={1}>{f.isDir ? '📁 ' : '📄 '}{f.name}</Text>
                    <Text style={styles.docMeta}>{f.isDir ? '文件夹' : `NAS · ${formatSize(f.size)}`}</Text>
                  </View>
                </Pressable>
              ))}
            </>
          ) : (
            <>
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
                    支持 PDF / Word / Markdown / TXT。目前 PDF·Word 只入库文件名（正文解析在下一批），
                    TXT / MD 可直接被搜索与问答引用。
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
        {mode === 'nas-only' ? (
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
              label="编辑标签 / 分组"
              onPress={() => {
                setTagEdit({ id: sheetDoc.id, text: (sheetDoc.tags || []).join('、') });
                setSheetDoc(null);
              }}
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
              onPress={() => { const id = sheetDoc.id; setSheetDoc(null); void removeDoc(id); }}
            />
            <Button label="取消" variant="ghost" onPress={() => setSheetDoc(null)} style={{ marginTop: space.s2 }} />
          </View>
        </View>
      )}

      {/* ---------- 标签编辑面板 ---------- */}
      {tagEdit && (
        <View style={styles.overlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setTagEdit(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>编辑标签 / 分组</Text>
            <Text style={styles.fieldHint}>多个标签用「、」或逗号分隔。第一个标签就是它所在的分组。</Text>
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
                  const has = tagEdit.text.includes(t);
                  return (
                    <Pressable
                      key={t}
                      onPress={() => {
                        const parts = tagEdit.text.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
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
                  const parts = tagEdit.text.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
                  void updateDocTags(tagEdit.id, parts);
                  setTagEdit(null);
                }}
                style={{ flex: 1, marginLeft: space.s2 }}
              />
            </View>
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
  chipsRow: { marginBottom: space.s2, flexGrow: 0 },
  chipsInner: { flexDirection: 'row', gap: 8, paddingRight: space.s3 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  chipText: { fontSize: 12.5, color: colors.muted, fontWeight: '600' },
  chipTextOn: { color: colors.primary },
  groupHead: {
    fontFamily: mono, fontSize: 10, letterSpacing: 1.4, color: colors.muted,
    textTransform: 'uppercase', marginBottom: 8, marginTop: 10, marginHorizontal: 2,
  },
  empty: { paddingVertical: space.s4, alignItems: 'center' },
  emptyText: { fontSize: 14, color: colors.text, marginBottom: 6 },
  emptyHint: { fontSize: 12, color: colors.muted, textAlign: 'center', paddingHorizontal: space.s4, lineHeight: 19 },
  card: {
    backgroundColor: colors.card, borderRadius: radius.xl,
    paddingHorizontal: space.s2 + 2, paddingVertical: space.s2, marginBottom: space.s1 + 2,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    ...shadow.card,
  },
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
