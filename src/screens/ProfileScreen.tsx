import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Switch, Pressable, TextInput } from 'react-native';
import { colors, mono, radius, shadow, space } from '../theme';
import Button from '../components/Button';
import { useStore } from '../store';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ModelSource, DataStrategy, Provider, ModelConfig, NasConnection } from '../types';
import type { AppSettings, PrivacySettings } from '../lib/settings';
import { testConnection } from '../lib/nas-webdav';
import { testParseService } from '../lib/nas-parse';
import { testModel, type ConnTestResult } from '../lib/llm';
import { testEmbedding, resetEmbeddingProbe } from '../lib/embedding';
import { localAvailability, loadedModelId } from '../lib/local-llm';
import { MODEL_CATALOG } from '../lib/local-models';

const sources: { key: ModelSource; label: string }[] = [
  { key: 'api', label: 'API（云端/自托管）' },
  { key: 'local', label: '手机本地' },
];
const providers: { key: Provider; label: string }[] = [
  { key: 'openai', label: 'OpenAI' },
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'claude', label: 'Claude' },
  { key: 'tongyi', label: '通义' },
  { key: 'zhipu', label: '智谱' },
  { key: 'custom', label: '自定义' },
];
const strategies: { key: DataStrategy; label: string }[] = [
  { key: 'local', label: '仅本地' },
  { key: 'local+sync', label: '本地+NAS同步' },
  { key: 'nas-only', label: '纯NAS后端' },
];

export default function ProfileScreen() {
  const {
    settings, updateSettings, saveNas, lock, nasPassword,
    embeddingCount, embeddingTotal, embeddingBusy, embeddingProgress,
    refreshEmbeddingStats, rebuildEmbeddings,
  } = useStore();
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  // 草稿态：所有改动先落在 draft，点「保存」才落盘 + 提示成功
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const mc = draft.modelConfig;

  // 本地模型可用性与加载状态。web / Expo Go 下 localAvailability() 回报不可用并给出原因，
  // 不抛异常 —— 这样整屏照常打开，本地项显示成「不可用 + 为什么」，其余来源不受影响。
  const local = localAvailability();
  const loadedId = loadedModelId();
  const loadedName = loadedId
    ? MODEL_CATALOG.find((m) => m.id === loadedId)?.name || loadedId
    : null;
  const localNote = !local.available
    ? local.reason
    : loadedName
      ? `已加载「${loadedName}」。整套推理在本机完成，资料与提问都不出手机。`
      : '还没有加载本地模型 —— 先到「手机本地模型」里下载或导入一个 .gguf，加载后这里才切得过来。';

  // API 配置卡片内的「测试连接」结果（真实发一次最小请求）
  const [modelTest, setModelTest] = useState<ConnTestResult | null>(null);
  const [testingModel, setTestingModel] = useState(false);

  // NAS 连接配置（密码不在 AppSettings 内，单独用本地态 + secure 层）
  const baseNas: NasConnection = { protocol: 'webdav', host: '', port: '', path: '/', secure: false, user: '' };
  const [nasForm, setNasForm] = useState<NasConnection | null>(settings.nas || null);
  const [nasPw, setNasPw] = useState(nasPassword);
  const [nasTest, setNasTest] = useState<{ ok: boolean; msg: string } | null>(null);

  const onTestNas = async () => {
    if (!nasForm?.host) { setNasTest({ ok: false, msg: '请先填写主机地址' }); return; }
    if (nasForm.protocol === 'smb') { setNasTest({ ok: false, msg: 'SMB 尚未接入，请先选 WebDAV。' }); return; }
    setNasTest(null);
    const r = await testConnection(nasForm, nasPw);
    setNasTest({ ok: r.ok, msg: r.message });
  };

  // 文档解析服务（PDF 高精度解析，跑在 NAS 上；不填也能用手机本地解析）
  const [psEndpoint, setPsEndpoint] = useState(settings.parseService?.endpoint || '');
  const [psToken, setPsToken] = useState(settings.parseService?.token || '');
  const [psTest, setPsTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [psTesting, setPsTesting] = useState(false);

  // 语义检索（嵌入服务）—— 不填就只走关键词；填了才是真正的「混合检索」
  const [emEndpoint, setEmEndpoint] = useState(settings.embedding?.endpoint || '');
  const [emToken, setEmToken] = useState(settings.embedding?.token || '');
  const [emModel, setEmModel] = useState(settings.embedding?.model || '');
  const [emTest, setEmTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [emTesting, setEmTesting] = useState(false);

  // 进页面就刷新「已索引 N/M」—— 否则导入新文档后分母是陈旧的
  useEffect(() => {
    void refreshEmbeddingStats();
  }, [refreshEmbeddingStats]);

  const onTestEmbed = async () => {
    const ep = emEndpoint.trim();
    if (!ep) { setEmTest({ ok: false, msg: '请先填写嵌入服务地址' }); return; }
    setEmTest(null);
    setEmTesting(true);
    const r = await testEmbedding({
      endpoint: ep,
      token: emToken.trim() || undefined,
      model: emModel.trim() || undefined,
    });
    setEmTest({ ok: r.ok, msg: r.message });
    setEmTesting(false);
  };

  const onTestParse = async () => {
    if (!psEndpoint.trim()) { setPsTest({ ok: false, msg: '请先填写服务地址' }); return; }
    setPsTest(null);
    setPsTesting(true);
    const r = await testParseService(psEndpoint.trim(), psToken.trim() || undefined);
    setPsTest({ ok: r.ok, msg: r.message });
    setPsTesting(false);
  };

  const patchModel = (p: Partial<ModelConfig>) =>
    setDraft((d) => ({ ...d, modelConfig: { ...d.modelConfig, ...p } }));
  const patchPrivacy = (p: Partial<PrivacySettings>) =>
    setDraft((d) => ({ ...d, privacy: { ...d.privacy, ...p } }));

  const seg = (
    opts: { key: string; label: string }[],
    value: string,
    onPick: (k: any) => void
  ) => (
    <View style={styles.seg}>
      {opts.map((o) => (
        <Pressable
          key={o.key}
          onPress={() => onPick(o.key)}
          style={[styles.segItem, value === o.key && styles.segItemOn]}
        >
          <Text style={[styles.segText, value === o.key && styles.segTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );

  // 测试 API 连接：用草稿里的配置真发一次最小请求，成功/失败都在卡片下方就地回显
  const onTestModel = async () => {
    setModelTest(null);
    setTestingModel(true);
    const r = await testModel(draft.modelConfig);
    setModelTest(r);
    setTestingModel(false);
  };

  const onSave = async () => {
    const ep = psEndpoint.trim();
    const em = emEndpoint.trim();
    await updateSettings({
      ...draft,
      parseService: ep ? { endpoint: ep, token: psToken.trim() || undefined } : undefined,
      embedding: em
        ? { endpoint: em, token: emToken.trim() || undefined, model: emModel.trim() || undefined }
        : undefined,
    });
    // 地址或模型换了 → 上次探索到的「服务形状」作废（云端与 NAS 的入参形状不同）
    if (em !== (settings.embedding?.endpoint || '') || emModel.trim() !== (settings.embedding?.model || '')) {
      resetEmbeddingProbe();
    }
    if (nasForm && nasForm.host) {
      await saveNas(nasForm, nasPw);
    } else {
      await updateSettings({ nas: undefined });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <View style={styles.wrap}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>模型来源</Text>
          {seg(sources, mc.source, (k) => patchModel({ source: k }))}
          {mc.source === 'local' && (
            <Text style={[styles.note, !local.available && { color: colors.muted }]}>{localNote}</Text>
          )}
          {mc.source === 'api' && <Text style={styles.note}>云端或自托管模型均走统一接口。家里 NAS 上的 Ollama 选「自定义」并填后端地址（如 http://192.168.0.xxx:11434/v1）即可。</Text>}
          {/* 入口常显、不只在选中「手机本地」时出现：合理的顺序是「先下载 → 再切来源」，
              若只在选中后才露出，用户会先切过去再被提示「还没加载」，白跑一趟。 */}
          <Pressable style={styles.linkRow} onPress={() => navigation.navigate('Models')}>
            <Text style={styles.linkText}>📦 手机本地模型（下载 / 导入 / 加载）</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>供应商</Text>
          {seg(providers, mc.provider || 'openai', (k) => patchModel({ provider: k }))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>API 配置</Text>
          {mc.provider === 'custom' && (
            <Field label="Base URL" placeholder="https://... 或 http://nas:11434/v1" value={mc.baseURL || ''} onChange={(v) => patchModel({ baseURL: v })} />
          )}
          <Field label="模型名" placeholder={mc.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'} value={mc.model || ''} onChange={(v) => patchModel({ model: v })} />
          {mc.source !== 'local' && (
            <Field label="API Key" placeholder="sk-..." secure value={mc.apiKey || ''} onChange={(v) => patchModel({ apiKey: v })} />
          )}
          <Text style={styles.note}>API Key 仅存于本机 secure-store，不上传。NAS 后端可由你在服务端代理官方 Key，进一步降低泄露面。</Text>
          <View style={styles.btnRow}>
            <Button
              label={testingModel ? '测试中…' : '测试连接'}
              variant="soft"
              disabled={testingModel}
              onPress={onTestModel}
              style={styles.btnHalf}
            />
            <Button label="保存配置" onPress={onSave} style={styles.btnHalf} />
          </View>
          {modelTest && (
            <Text style={[styles.note, { color: modelTest.ok ? colors.green : colors.red }]}>
              {modelTest.ok ? '✅ ' : '⚠️ '}{modelTest.detail}
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>数据策略</Text>
          {seg(strategies, draft.dataStrategy, (k) => setDraft((d) => ({ ...d, dataStrategy: k })))}
          <Text style={styles.note}>
            {draft.dataStrategy === 'local' && '资料只存手机本地，无需额外配置。'}
            {draft.dataStrategy === 'local+sync' && '手机本地为主，可从 NAS 同步资料建本地索引，离线也能搜。'}
            {draft.dataStrategy === 'nas-only' && '手机仅作客户端，联网时直接从 NAS 浏览 / 使用资料，不占手机空间。'}
          </Text>
        </View>

        {draft.dataStrategy !== 'local' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>NAS 连接</Text>
            <Text style={styles.note}>用于「本地+NAS同步 / 纯NAS后端」。目前先落地 WebDAV（SMB 后续接入）。</Text>
            <View style={{ height: space.s2 }} />
            {seg([{ key: 'webdav', label: 'WebDAV' }, { key: 'smb', label: 'SMB（后续）' }], nasForm?.protocol || 'webdav', (k) => setNasForm({ ...baseNas, ...(nasForm || {}), protocol: k }))}
            <Field label="主机" placeholder="192.168.0.xxx" value={nasForm?.host || ''} onChange={(v) => setNasForm({ ...baseNas, ...(nasForm || {}), host: v })} />
            <Field label="端口" placeholder="5005" value={nasForm?.port || ''} onChange={(v) => setNasForm({ ...baseNas, ...(nasForm || {}), port: v })} />
            <Field label="路径" placeholder="/ 或 /webdav" value={nasForm?.path || ''} onChange={(v) => setNasForm({ ...baseNas, ...(nasForm || {}), path: v })} />
            <Row label="使用 HTTPS" value={<Switch value={nasForm?.secure || false} onValueChange={(v) => setNasForm({ ...baseNas, ...(nasForm || {}), secure: v })} />} />
            <Field label="用户名" placeholder="NAS 账号" value={nasForm?.user || ''} onChange={(v) => setNasForm({ ...baseNas, ...(nasForm || {}), user: v })} />
            <Field label="密码" placeholder="NAS 密码" secure value={nasPw} onChange={setNasPw} />
            <Button label={nasTest ? '重新测试连接' : '测试连接'} variant="soft" onPress={onTestNas} style={styles.testBtn} />
            {nasTest && (
              <Text style={[styles.note, { color: nasTest.ok ? colors.green : colors.red }]}>
                {nasTest.ok ? '✅ ' : '⚠️ '}{nasTest.msg}
              </Text>
            )}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>文档解析服务</Text>
          <Text style={styles.note}>
            PDF / Word 导入后要提取正文才能被检索。手机自带的 PDF 解析够用但保守（复杂排版可能掉字）；
            填上 NAS 上的解析服务地址后，PDF 会优先送过去用 PyMuPDF 解，失败自动退回手机本地。不填 = 全程离线自足。
          </Text>
          <View style={{ height: space.s2 }} />
          <Field label="服务地址" placeholder="http://192.168.0.109:8787" value={psEndpoint} onChange={setPsEndpoint} />
          <Field label="访问令牌（可选）" placeholder="服务端未设令牌则留空" secure value={psToken} onChange={setPsToken} />
          <Button
            label={psTesting ? '测试中…' : '测试连接'}
            variant="soft"
            disabled={psTesting}
            onPress={onTestParse}
            style={styles.testBtn}
          />
          {psTest && (
            <Text style={[styles.note, { color: psTest.ok ? colors.green : colors.red }]}>
              {psTest.ok ? '✅ ' : '⚠️ '}{psTest.msg}
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>语义检索（嵌入服务）</Text>
          <Text style={styles.note}>
            关键词检索只能命中「原文有这几个字」的段落，问法一换词就漏（搜「有效期」而原文写「保质期」）。
            填上嵌入服务后，检索变成「关键词 + 语义」双路并用 RRF 融合，也就是混合检索。
            NAS 上的解析服务自带 /embed（bge-small-zh），填同一个地址即可；也可以填任意 OpenAI 兼容服务。
            不填 = 只用关键词，完全离线可用。
          </Text>
          <View style={{ height: space.s2 }} />
          <Field label="服务地址" placeholder="http://192.168.0.109:8787" value={emEndpoint} onChange={setEmEndpoint} />
          <Field label="访问令牌（可选）" placeholder="NAS 未设令牌则留空；云端填 API Key" secure value={emToken} onChange={setEmToken} />
          <Field label="模型名（云端必填，NAS 可留空）" placeholder="text-embedding-3-small" value={emModel} onChange={setEmModel} />
          <Button
            label={emTesting ? '测试中…' : '测试连接'}
            variant="soft"
            disabled={emTesting}
            onPress={onTestEmbed}
            style={styles.testBtn}
          />
          {emTest && (
            <Text style={[styles.note, { color: emTest.ok ? colors.green : colors.red }]}>
              {emTest.ok ? '✅ ' : '⚠️ '}{emTest.msg}
            </Text>
          )}
          <View style={{ height: space.s2 }} />
          <Row
            label="语义索引"
            value={
              <Text style={styles.note}>
                {embeddingCount > 0
                  ? `已建 ${embeddingCount} / ${embeddingTotal} 块`
                  : `未建立（共 ${embeddingTotal} 块可建）`}
              </Text>
            }
          />
          <Button
            label={embeddingBusy ? `重建中… ${embeddingProgress || ''}` : '重建语义索引'}
            variant="soft"
            disabled={embeddingBusy}
            onPress={() => { void rebuildEmbeddings(); }}
            style={styles.testBtn}
          />
          <Text style={styles.note}>
            先用上面的「保存」把地址存下来，再点重建。改了模型或地址后必须重建 ——
            不同模型算出的向量维度与语义都不一样，混用会得到无意义的结果。向量属派生数据，重算即可。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>隐私与安全</Text>
          <Row label="隐私锁（Face ID / 密码）" value={<Switch value={draft.privacy.faceID} onValueChange={(v) => patchPrivacy({ faceID: v })} />} />
          <Row label="离线模式（禁用联网）" value={<Switch value={draft.privacy.offlineMode} onValueChange={(v) => patchPrivacy({ offlineMode: v })} />} />
          <Row label="云端调用需确认" value={<Switch value={draft.privacy.cloudConfirm} onValueChange={(v) => patchPrivacy({ cloudConfirm: v })} />} />
          <Text style={styles.note}>
            离线模式：打开后所有联网动作都会直接拦下并说明原因（云端模型、NAS 解析、NAS 同步、语义检索、
            模型下载）。此时仍可用的组合是「手机本地模型 + 手机本地解析 + 关键词检索」，全程不联网。
          </Text>
          <Text style={styles.note}>
            云端调用需确认：在把资料发出你的网络之前弹窗确认。判定看地址 ——
            NAS、192.168.x 这类内网地址不会询问（资料没出去）；只有真正对外的地址才拦。
            已接入这条确认的动作：云端问答、语义检索生成向量、NAS 文档解析。
          </Text>
          <Text style={styles.note}>两个开关保存后立即生效，不用重启。</Text>
        </View>

        <View style={styles.card}>
          <Pressable style={styles.linkRow} onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.linkText}>⚙️ 更多设置（导出格式 / 数据管理）</Text>
          </Pressable>
          <Pressable style={styles.linkRow} onPress={lock}>
            <Text style={[styles.linkText, { color: colors.red }]}>🔒 立即锁定</Text>
          </Pressable>
        </View>

        <Button label="保存" onPress={onSave} style={styles.saveBtn} />
      </ScrollView>

      {saved && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>✅ 保存成功</Text>
        </View>
      )}
    </View>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value}
    </View>
  );
}

function Field({ label, placeholder, value, onChange, secure }: { label: string; placeholder?: string; value: string; onChange: (v: string) => void; secure?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.fieldInput} placeholder={placeholder} placeholderTextColor={colors.muted} value={value} onChangeText={onChange} secureTextEntry={secure} autoCapitalize="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  container: { padding: space.s3, backgroundColor: colors.background, flexGrow: 1 },
  title: { fontSize: 26, fontWeight: '700', color: colors.text, letterSpacing: -0.8, marginBottom: space.s2 },
  card: { backgroundColor: colors.card, borderRadius: radius.xl, padding: 14, marginBottom: space.s1 + 2, ...shadow.card },
  cardTitle: { fontSize: 12.5, fontWeight: '700', color: colors.text2, letterSpacing: 0.2, marginBottom: 10 },
  seg: { flexDirection: 'row', backgroundColor: colors.background, borderRadius: radius.md, padding: 3, gap: 3 },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: radius.md - 3, alignItems: 'center' },
  segItemOn: { backgroundColor: colors.primary },
  segText: { fontSize: 12.5, color: colors.muted, fontWeight: '600' },
  segTextOn: { color: '#fff' },
  note: { fontFamily: mono, fontSize: 10.5, color: colors.faint, marginTop: space.s2, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.s1 },
  rowLabel: { fontSize: 13.5, color: colors.text },
  field: { marginBottom: space.s2 },
  fieldLabel: { fontFamily: mono, fontSize: 10, letterSpacing: 0.8, color: colors.muted, marginBottom: 5 },
  fieldInput: { backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13.5, color: colors.text },
  linkRow: { paddingVertical: space.s2 },
  linkText: { fontSize: 13.5, color: colors.primary, fontWeight: '600' },
  testBtn: { marginTop: space.s2, marginBottom: space.s1 },
  btnRow: { flexDirection: 'row', gap: space.s2, marginTop: space.s2 },
  btnHalf: { flex: 1 },
  saveBtn: { marginTop: space.s1, marginBottom: space.s4 },
  toast: { position: 'absolute', bottom: 40, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.82)', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 20 },
  toastText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
