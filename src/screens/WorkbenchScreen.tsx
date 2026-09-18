// 工作台（融合版首页）
// 上半 = A 的提问台（打开就能问），下半 = B 的 Bento 状态（抬眼就知道索引/服务什么状态）
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStore } from '../store';
import TabGlyph from '../components/TabGlyph';
import { colors, mono, radius, shadow, space } from '../theme';
import type { Document } from '../types';

const QUICK = ['适用期', '弯曲强度', '存放条件', '配比'];

function weekday(d: Date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

function extLabel(t: Document['type']) {
  return t === 'pdf' ? 'PDF' : t === 'word' ? 'DOCX' : t === 'md' ? 'MD' : 'TXT';
}

export default function WorkbenchScreen() {
  const nav = useNavigation<any>();
  const { documents, embeddingCount, embeddingTotal, sendMessage, thinking, settings, rebuildEmbeddings, embeddingBusy, importFiles, importing } =
    useStore();
  const [q, setQ] = useState('');

  const hasEmbed = !!settings.embedding?.endpoint;
  const notIndexed = documents.filter((d) => d.status !== 'indexed').length;
  const recent = [...documents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 3);
  const now = new Date();
  const pct = embeddingTotal ? embeddingCount / embeddingTotal : 0;

  const submit = () => {
    const t = q.trim();
    if (!t || thinking) return;
    setQ('');
    void sendMessage(t);
    nav.navigate('Chat');
  };

  return (
    <View style={s.root}>
      {/* 顶栏 */}
      <View style={s.topbar}>
        <View style={s.brand}>
          <View style={s.logo}>
            <Text style={s.logoT}>京</Text>
          </View>
          <Text style={s.bn}>京美AI助手</Text>
        </View>
        <View style={s.topRight}>
          <Text style={s.dt}>
            {now.getMonth() + 1}月{now.getDate()}日 {weekday(now)}
          </Text>
          <Pressable onPress={() => nav.navigate('Profile')} style={s.setBtn}>
            <TabGlyph name="gear" color={colors.text2} size={14} />
            <Text style={s.setT}>设置</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.bodyC} keyboardShouldPersistTaps="handled">
        {/* 提问台（来自 A） */}
        <View style={s.ask}>
          <TextInput
            style={s.askInput}
            placeholder="问一句，比如：CY1578 的固化剂配比？"
            placeholderTextColor={colors.faint}
            value={q}
            onChangeText={setQ}
            multiline
            onSubmitEditing={submit}
          />
          <View style={s.askRow}>
            <View style={s.tg}>
              <View style={s.dot} />
              <Text style={s.tgT}>{hasEmbed ? '关键词 + 语义双路' : '仅关键词（未配语义服务）'}</Text>
            </View>
            <Pressable style={[s.go, (!q.trim() || thinking) && s.goOff]} onPress={submit}>
              <Text style={s.goT}>↑</Text>
            </Pressable>
          </View>
        </View>

        <View style={s.chips}>
          {QUICK.map((c) => (
            <Pressable key={c} style={s.ch} onPress={() => setQ((v) => (v ? v : c + '是多少？'))}>
              <Text style={s.chT}>{c}</Text>
            </Pressable>
          ))}
        </View>

        {/* Bento 状态（来自 B） */}
        <Text style={s.sect}>状态</Text>
        <View style={s.grid}>
          <View style={[s.cd, s.s2]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <View>
                <Text style={s.lb}>语义检索</Text>
                <View style={s.mtx}>
                  <Text style={s.mtxV}>{embeddingCount}</Text>
                  <Text style={s.mtxU}>/ {embeddingTotal} 块已建</Text>
                </View>
              </View>
              <View style={[s.pill, !hasEmbed && s.pillOff]}>
                <View style={[s.pt, !hasEmbed && s.ptOff]} />
                <Text style={[s.pillT, !hasEmbed && s.pillTOff]}>{hasEmbed ? (embeddingCount >= embeddingTotal && embeddingTotal > 0 ? '就绪' : '未建全') : '未配置'}</Text>
              </View>
            </View>
            <View style={s.pr}>
              <View style={[s.prI, { width: `${Math.round(pct * 100)}%` }]} />
            </View>
            <Text style={s.ft} numberOfLines={1}>
              {hasEmbed ? `${settings.embedding?.endpoint} · ${settings.embedding?.model || 'bge-small-zh-v1.5'}` : '「我的 → 语义检索」填服务地址后启用'}
            </Text>
            {hasEmbed ? (
              <Pressable style={s.miniBtn} onPress={() => void rebuildEmbeddings()} disabled={embeddingBusy}>
                <Text style={s.miniBtnT}>{embeddingBusy ? '重建中…' : '重建索引'}</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={[s.cd, s.cdHalf]}>
            <Text style={s.lb}>资料</Text>
            <Text style={s.bg}>
              {documents.length}
              <Text style={s.bgU}>份</Text>
            </Text>
            <Text style={s.ft}>{notIndexed ? `${notIndexed} 份待索引` : '全部已索引'}</Text>
          </View>
          <View style={[s.cd, s.cdHalf]}>
            <Text style={s.lb}>文本块</Text>
            <Text style={s.bg}>{embeddingTotal}</Text>
            <Text style={s.ft}>关键词全命中</Text>
          </View>
        </View>

        {/* 最近资料 */}
        <View style={s.sectRow}>
          <Text style={[s.sect, s.sectInline]}>最近资料</Text>
          <Pressable onPress={() => void importFiles()} disabled={importing} hitSlop={6}>
            <Text style={s.sectBtn}>{importing ? '导入中…' : '＋ 导入'}</Text>
          </Pressable>
        </View>
        <View style={s.grp}>
          {recent.length === 0 ? (
            <View style={s.dl}>
              <Text style={{ fontSize: 13, color: colors.muted, paddingVertical: 6 }}>还没有资料，去「资料库」导入</Text>
            </View>
          ) : (
            recent.map((d) => (
              <Pressable key={d.id} style={s.dl} onPress={() => nav.navigate('Library')}>
                <Text style={s.ex}>{extLabel(d.type)}</Text>
                <View style={s.dlT}>
                  <Text style={s.dlN} numberOfLines={1}>
                    {d.name}
                  </Text>
                  <Text style={s.dlM} numberOfLines={1}>
                    {[d.meta.model, d.meta.chars ? `${d.meta.chars} 字` : '', d.meta.pages ? `${d.meta.pages} 页` : '', d.meta.parseSource === 'nas' ? 'NAS' : d.meta.parseSource === 'local' ? '本地' : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <View style={[s.pill, d.status !== 'indexed' && s.pillOff]}>
                  <View style={[s.pt, d.status !== 'indexed' && s.ptOff]} />
                  <Text style={[s.pillT, d.status !== 'indexed' && s.pillTOff]}>{d.status === 'indexed' ? '已索引' : '未索引'}</Text>
                </View>
              </Pressable>
            ))
          )}
        </View>
        <View style={{ height: space.s4 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  topbar: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  logo: {
    width: 29, height: 29, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#8ea6f7', shadowColor: '#7882dc', shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  logoT: { color: '#fff', fontSize: 12.5, fontWeight: '700' },
  bn: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2, color: colors.text },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  dt: { fontFamily: mono, fontSize: 10.5, color: colors.muted },
  // 设置不在 Tab 栏里，入口必须够显眼，否则改模型/NAS 要找不到路
  setBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6,
  },
  setT: { fontSize: 11.5, fontWeight: '600', color: colors.text2 },

  body: { flex: 1 },
  bodyC: { paddingHorizontal: 17, paddingBottom: 8 },

  // 提问台
  ask: {
    backgroundColor: colors.card, borderRadius: 20, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 17, paddingTop: 15, paddingBottom: 13, ...shadow.lift,
  },
  askInput: { fontSize: 14, color: colors.text, lineHeight: 20, minHeight: 22, padding: 0 },
  askRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 15 },
  tg: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 5.5, height: 5.5, borderRadius: 3, backgroundColor: '#2fb763' },
  tgT: { fontFamily: mono, fontSize: 10.5, color: colors.muted },
  go: {
    width: 35, height: 35, borderRadius: 18, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  goOff: { backgroundColor: colors.faint, shadowOpacity: 0 },
  goT: { color: '#fff', fontSize: 16, fontWeight: '700' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 11 },
  ch: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 7, ...shadow.card },
  chT: { fontSize: 12, color: colors.text2 },

  // Bento
  sect: { fontFamily: mono, fontSize: 10, letterSpacing: 1.4, color: colors.muted, textTransform: 'uppercase', marginTop: 18, marginBottom: 9, marginHorizontal: 2 },
  sectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 9, marginHorizontal: 2 },
  sectInline: { marginTop: 0, marginBottom: 0, marginHorizontal: 0 },
  sectBtn: { fontFamily: mono, fontSize: 10.5, fontWeight: '700', color: colors.primary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cd: { backgroundColor: colors.card, borderRadius: 18, padding: 14, ...shadow.card },
  s2: { width: '100%' },
  cdHalf: { width: '48%' },
  lb: { fontSize: 11.5, color: colors.muted, fontWeight: '600' },
  bg: { fontSize: 29, fontWeight: '700', letterSpacing: -1.2, color: colors.text, marginTop: 8, fontFamily: mono },
  bgU: { fontSize: 12, fontWeight: '600', color: colors.muted, letterSpacing: 0 },
  ft: { fontFamily: mono, fontSize: 10, color: colors.faint, marginTop: 7 },
  mtx: { flexDirection: 'row', alignItems: 'baseline', gap: 7, marginTop: 8 },
  mtxV: { fontFamily: mono, fontSize: 24, fontWeight: '700', letterSpacing: -0.8, color: colors.text },
  mtxU: { fontSize: 11, color: colors.muted, fontWeight: '600' },
  pr: { marginTop: 11, height: 6, borderRadius: 3, backgroundColor: '#eceef4', overflow: 'hidden' },
  prI: { height: '100%', borderRadius: 3, backgroundColor: colors.primary },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.greenSoft, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 5 },
  pillT: { fontFamily: mono, fontSize: 10.5, fontWeight: '700', color: colors.green },
  pt: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#2fb763' },
  pillOff: { backgroundColor: colors.borderSoft },
  pillTOff: { color: colors.muted },
  ptOff: { backgroundColor: '#c3c9d4' },
  miniBtn: { marginTop: 10, alignSelf: 'flex-start', backgroundColor: colors.primarySoft, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  miniBtnT: { fontFamily: mono, fontSize: 10.5, fontWeight: '700', color: colors.primary },

  // 最近资料
  grp: { backgroundColor: colors.card, borderRadius: 17, paddingHorizontal: 14, paddingVertical: 2, ...shadow.card },
  dl: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.borderSoft },
  ex: { fontFamily: mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, color: colors.primary, backgroundColor: colors.primarySoft, borderRadius: 6, paddingVertical: 5, width: 34, textAlign: 'center', overflow: 'hidden' },
  dlT: { flex: 1, minWidth: 0 },
  dlN: { fontSize: 12.5, fontWeight: '600', color: colors.text },
  dlM: { fontFamily: mono, fontSize: 9.5, color: colors.faint, marginTop: 3 },
});
