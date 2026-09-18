// 对比（需求符合性检查）
// 把「技术要求 / 工况」贴进来，从资料库里逐项核对，输出 满足 / 差一点 / 不满足。
// 结果不写进任何会话：这是一个常驻 Tab，每次比对都变成一条聊天记录会把会话列表冲垮。
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from '../store';
import ComplianceTable from '../components/ComplianceTable';
import { complianceToCsv, shareText } from '../lib/export';
import { colors, mono, radius, shadow, space } from '../theme';

const EXAMPLE = '拉挤工艺用环氧树脂：\n弯曲强度 ≥ 110 MPa\n拉伸强度 ≥ 75 MPa\n热变形温度 ≥ 130 °C\n适用期（25°C）≥ 90 min\n粘度 8 000–15 000 mPa·s';

export default function CompareScreen() {
  const { compareResult, compareBusy, compareError, runCompare, clearCompare, documents } = useStore();
  const [req, setReq] = useState('');
  const [msg, setMsg] = useState('');

  const items = compareResult?.items ?? [];
  const ok = items.filter((i) => i.verdict === 'ok').length;
  const near = items.filter((i) => i.verdict === 'warn').length;
  const bad = items.filter((i) => i.verdict === 'no').length;
  const nearNames = items.filter((i) => i.verdict === 'warn').map((i) => i.item);

  const start = () => {
    if (!req.trim() || compareBusy) return;
    setMsg('');
    void runCompare(req);
  };

  return (
    <View style={s.root}>
      <View style={s.topbar}>
        <Text style={s.h1}>对比</Text>
        <Text style={s.dt}>{compareResult ? `${items.length} 项 · ${ok} 满足` : '逐项核对'}</Text>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.bodyC} keyboardShouldPersistTaps="handled">
        {/* 谁跟谁比 */}
        <View style={s.vsRow}>
          <View style={s.vsCard}>
            <Text style={s.vsK}>实测 / TDS</Text>
            <Text style={s.vsV} numberOfLines={1}>
              {documents.length ? `资料库 · ${documents.length} 份` : '资料库为空'}
            </Text>
          </View>
          <Text style={s.vsArrow}>→</Text>
          <View style={s.vsCard}>
            <Text style={s.vsK}>规格要求</Text>
            <Text style={s.vsV} numberOfLines={1}>
              你贴的技术要求
            </Text>
          </View>
        </View>

        {/* 输入要求 */}
        <View style={s.ask}>
          <TextInput
            style={s.askInput}
            placeholder={'贴上技术要求 / 工况，一行一条。\n例如：弯曲强度 ≥ 110 MPa'}
            placeholderTextColor={colors.faint}
            value={req}
            onChangeText={setReq}
            multiline
          />
          <View style={s.askRow}>
            <Pressable onPress={() => setReq(EXAMPLE)}>
              <Text style={s.link}>填入示例</Text>
            </Pressable>
            <Pressable style={[s.go, (!req.trim() || compareBusy) && s.goOff]} onPress={start}>
              <Text style={s.goT}>{compareBusy ? '…' : '开始比对'}</Text>
            </Pressable>
          </View>
        </View>

        {compareBusy ? (
          <View style={s.busy}>
            <ActivityIndicator color={colors.primary} />
            <Text style={s.busyT}>正在检索资料并逐项核对…</Text>
          </View>
        ) : null}

        {!!compareError ? <Text style={s.err}>⚠️ {compareError}</Text> : null}
        {!!msg ? <Text style={s.msg}>{msg}</Text> : null}

        {compareResult ? (
          <>
            <Text style={s.sect}>逐项判定 · {compareResult.model}</Text>
            <ComplianceTable result={compareResult} showConclusion={false} />

            {near > 0 ? (
              <View style={s.tip}>
                <Text style={s.tipTag}>差一点</Text>
                <Text style={s.tipT} numberOfLines={2}>
                  {nearNames.join('、')} —— 见下方结论
                </Text>
              </View>
            ) : null}

            {!!compareResult.conclusion ? (
              <>
                <Text style={s.sect}>结论</Text>
                <View style={s.concl}>
                  <Text style={s.conclT}>{compareResult.conclusion}</Text>
                  <Text style={s.conclSrc}>由资料库 {items.length} 项比对生成</Text>
                </View>
              </>
            ) : null}

            <Pressable style={s.clear} onPress={() => { clearCompare(); setMsg(''); }}>
              <Text style={s.clearT}>清空，重新比对</Text>
            </Pressable>
          </>
        ) : !compareBusy ? (
          <View style={s.empty}>
            <Text style={s.emptyT}>还没有比对结果</Text>
            <Text style={s.emptyS}>
              贴一段采购规格或工况要求，助手会从资料库里找出最匹配的树脂体系，逐项判定是否满足。
            </Text>
          </View>
        ) : null}

        <View style={{ height: space.s4 }} />
      </ScrollView>

      {compareResult ? (
        <View style={s.sum}>
          <Text style={s.sumT}>
            <Text style={s.sumB}>{ok}</Text> 满足 · <Text style={s.sumB}>{near}</Text> 差一点 ·{' '}
            <Text style={s.sumB}>{bad}</Text> 不满足
          </Text>
          <Pressable
            style={s.sumBtn}
            onPress={async () => {
              setMsg(await shareText(`符合性检查-${compareResult.model}`, complianceToCsv(compareResult)));
            }}
          >
            <Text style={s.sumBtnT}>导出</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  topbar: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  h1: { fontSize: 26, fontWeight: '700', letterSpacing: -0.8, color: colors.text },
  dt: { fontFamily: mono, fontSize: 11, color: colors.muted, paddingBottom: 4 },
  body: { flex: 1 },
  bodyC: { paddingHorizontal: 17, paddingBottom: 8 },

  vsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  vsCard: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: 11, paddingVertical: 9, ...shadow.card },
  vsK: { fontFamily: mono, fontSize: 9, letterSpacing: 1, color: colors.muted },
  vsV: { fontSize: 12.5, fontWeight: '600', color: colors.text, marginTop: 3 },
  vsArrow: { color: colors.faint, fontSize: 14 },

  ask: { backgroundColor: colors.card, borderRadius: radius.xxl, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 17, paddingTop: 14, paddingBottom: 12, ...shadow.lift },
  askInput: { fontSize: 13.5, color: colors.text, lineHeight: 20, minHeight: 64, maxHeight: 140, padding: 0, textAlignVertical: 'top' },
  askRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  link: { fontFamily: mono, fontSize: 10.5, color: colors.muted, textDecorationLine: 'underline' },
  go: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  goOff: { backgroundColor: colors.faint },
  goT: { color: '#fff', fontSize: 12.5, fontWeight: '700' },

  busy: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, justifyContent: 'center' },
  busyT: { fontFamily: mono, fontSize: 11, color: colors.muted },
  err: { marginTop: 16, fontSize: 12.5, color: colors.bad, lineHeight: 19 },
  msg: { marginTop: 12, fontFamily: mono, fontSize: 11, color: colors.muted },

  sect: { fontFamily: mono, fontSize: 10, letterSpacing: 1.4, color: colors.muted, textTransform: 'uppercase', marginTop: 18, marginBottom: 9, marginHorizontal: 2 },

  tip: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.card, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10, ...shadow.card },
  tipTag: { fontFamily: mono, fontSize: 9.5, fontWeight: '700', color: colors.warn, backgroundColor: colors.warnSoft, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4 },
  tipT: { flex: 1, fontSize: 11.5, color: colors.text2, lineHeight: 17 },

  concl: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 13, ...shadow.card },
  conclT: { fontSize: 12.5, lineHeight: 19, color: colors.text2 },
  conclSrc: { fontFamily: mono, fontSize: 10, color: colors.faint, marginTop: 8 },

  clear: { alignSelf: 'center', marginTop: 18, paddingVertical: 6 },
  clearT: { fontFamily: mono, fontSize: 11, color: colors.muted, textDecorationLine: 'underline' },

  empty: { marginTop: 40, alignItems: 'center', paddingHorizontal: 20 },
  emptyT: { fontSize: 14, fontWeight: '600', color: colors.text2 },
  emptyS: { marginTop: 8, fontSize: 12.5, lineHeight: 19, color: colors.muted, textAlign: 'center' },

  sum: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 17, marginBottom: 10, marginTop: 12, backgroundColor: colors.ink, borderRadius: radius.xl, paddingHorizontal: 15, paddingVertical: 13, shadowColor: '#101430', shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 6 },
  sumT: { fontFamily: mono, fontSize: 12, color: '#c3c9d4' },
  sumB: { color: '#fff', fontWeight: '700' },
  sumBtn: { marginLeft: 'auto', backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 8 },
  sumBtnT: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
