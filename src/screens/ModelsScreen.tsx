// 模型管理页 —— 「后续自己加模型」的落地形态
//
// 三个入口对应三种真实场景：
//   在线下载：没有 NAS、也没有现成文件时的兜底（默认走 hf-mirror 镜像，国内直连 HF 常不通）
//   NAS 拉取：局域网传输，最快且不耗外网流量（与项目本身的 NAS 基因一致）
//   文件导入：「文件」App 里已有的 .gguf（AirDrop / 微信 / iCloud 传进来的）
//
// 三条自我约束：
//   ① 内存不够的模型**下载前**就提示，不是等加载崩了才说（iOS 上是被系统直接杀掉，没有报错机会）；
//   ② 导入格式不对**明确指出**问题是什么，不说「失败」；
//   ③ 删除必须二次确认，且是逐项确认，没有「全清空」。
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View, Platform,
} from 'react-native';
import * as Device from 'expo-device';
import { useStore } from '../store';
import { colors, mono, radius, shadow, space } from '../theme';
import { localAvailability, loadLocalModel, loadedModelId, unloadLocalModel } from '../lib/local-llm';
import {
  FIT_TEXT,
  MODEL_CATALOG,
  SOURCE_LABEL,
  SYSTEM_MODEL,
  TIER_LABEL,
  fitForModel,
  formatBytes,
  pickForTier,
  systemModelStatus,
  tierForMemory,
  usableBytes,
  type CatalogModel,
  type LocalModelRecord,
} from '../lib/local-models';
import {
  deleteLocalModel,
  downloadCatalogModel,
  downloadFromUrl,
  freeSpace,
  importModelFromFiles,
  listLocalModels,
  cancelActiveDownload,
  isDownloading,
  DOWNLOAD_CANCELLED,
  type DownloadProgress,
} from '../lib/model-store';

type Entrance = 'catalog' | 'nas' | 'file';

// 来源标签在纯逻辑层（SOURCE_LABEL），这里只负责渲染。
// record.source 是可缺省的：用户自己用「文件」App 塞进沙盒的模型没有来源记录，
// 这种情况宁可不显示，也不要默认成「在线下载」。

export default function ModelsScreen() {
  // settings 里存镜像源偏好，退出再进来不用重选
  const { settings, updateSettings } = useStore();

  const [entrance, setEntrance] = useState<Entrance>('catalog');
  const [installed, setInstalled] = useState<LocalModelRecord[]>([]);
  const [listing, setListing] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [prog, setProg] = useState<DownloadProgress | null>(null);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [nasUrl, setNasUrl] = useState('');
  const [nasName, setNasName] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [free, setFree] = useState(0);
  const [loadedId, setLoadedId] = useState<string | null>(loadedModelId());

  const avail = localAvailability();
  const totalMem = Number(Device.totalMemory) || 0;
  // 系统内置模型的状态由**真判断**得出（平台 / 系统版本 / 内存档位），不是写死的文案
  const sysStatus = systemModelStatus({
    os: Platform.OS,
    major: Number(String((Platform as any).Version).split('.')[0]) || 0,
    memBytes: totalMem,
  });
  const tier = tierForMemory(totalMem);
  const recommend = pickForTier(tier);
  const usedBytes = installed.reduce((n, r) => n + (r.bytes || 0), 0);
  const installedIds = new Set(installed.map((r) => r.id));
  // 默认走镜像：国内直连 huggingface.co 大概率超时，让用户先踩一次坑没有意义
  const useMirror = settings.localMirror !== false;

  const refresh = useCallback(async () => {
    setListing(true);
    try {
      setInstalled(await listLocalModels());
      setFree(await freeSpace());
    } catch (e: any) {
      setErr(`读取已装模型失败：${e?.message || e}`);
    } finally {
      setListing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runDownload = async (m: CatalogModel) => {
    setErr(null);
    setTip(null);
    setBusyId(m.id);
    setProg(null);
    try {
      const rec = await downloadCatalogModel(m, useMirror, setProg);
      setTip(`「${rec.name}」已下载完成（${formatBytes(rec.bytes)}${rec.quant ? ` · ${rec.quant}` : ''}）。点「加载」就能用于问答。`);
      await refresh();
    } catch (e: any) {
      // 取消不是错误：说「下载失败」会让用户以为网络或地址有问题
      if (String(e?.message) === DOWNLOAD_CANCELLED) setTip(`已取消「${m.name}」的下载，没留下半成品。`);
      else setErr(e?.message || String(e));
    } finally {
      setBusyId(null);
      setProg(null);
    }
  };

  const runNasPull = async () => {
    setErr(null);
    setTip(null);
    const url = nasUrl.trim();
    if (!url) {
      setErr('先填 NAS 上的模型地址，形如 http://192.168.0.x:8788/models/xxx.gguf');
      return;
    }
    const name = (nasName.trim() || url.split('/').pop() || 'model.gguf').split('?')[0];
    setBusyId('__nas__');
    setProg(null);
    try {
      const rec = await downloadFromUrl(url, name, 0, setProg);
      setTip(`已从 NAS 拉取「${rec.name}」（${formatBytes(rec.bytes)}）。`);
      setNasUrl('');
      setNasName('');
      await refresh();
    } catch (e: any) {
      if (String(e?.message) === DOWNLOAD_CANCELLED) setTip('已取消，没留下半成品。');
      else setErr(e?.message || String(e));
    } finally {
      setBusyId(null);
      setProg(null);
    }
  };

  const runImport = async () => {
    setErr(null);
    setTip(null);
    setBusyId('__file__');
    try {
      const rec = await importModelFromFiles();
      if (!rec) setTip('已取消选择。');
      else {
        setTip(`已导入「${rec.name}」（${formatBytes(rec.bytes)}${rec.quant ? ` · ${rec.quant}` : ''}）。`);
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const doLoad = async (rec: LocalModelRecord) => {
    setErr(null);
    setTip(null);
    // 内存不够必须在**加载前**拦住，不能等崩：iOS 上超限是被系统直接杀掉、没有报错机会，
    // 用户看到的现象是「点加载 → App 没了」，根本联想不到内存。这一屏自己的约束①就是这条。
    if (avail.available && fitForModel(rec.bytes, totalMem) === 'no') {
      Alert.alert(
        '这个模型装不进当前机型的内存',
        `${rec.name} 需要约 ${formatBytes(rec.bytes)}，而本机可用内存装不下它。\n\n继续加载的话，iOS 会直接终止 App（不会有任何报错）。`,
        [
          { text: '不加载', style: 'cancel' },
          {
            text: '仍要加载',
            style: 'destructive',
            onPress: () => void reallyLoad(rec),
          },
        ]
      );
      return;
    }
    await reallyLoad(rec);
  };

  const reallyLoad = async (rec: LocalModelRecord) => {
    setBusyId(`load:${rec.id}`);
    setLoadNote('准备中…');
    try {
      await loadLocalModel({ id: rec.id, uri: rec.uri, ctx: rec.ctxUse }, ({ ratio, note }) => {
        setLoadNote(ratio == null ? note : `${note} ${Math.round(ratio * 100)}%`);
      });
      setLoadedId(rec.id);
      setTip(`「${rec.name}」已加载。现在去「问答」提问就走手机本地推理了。`);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setLoadedId(null);
    } finally {
      setBusyId(null);
      setLoadNote(null);
    }
  };

  const doUnload = async () => {
    setErr(null);
    setTip(null);
    await unloadLocalModel();
    setLoadedId(null);
    setTip('已释放模型占用的内存。切回本地模型时再加载一次即可。');
  };

  const doDelete = async (rec: LocalModelRecord) => {
    setErr(null);
    setTip(null);
    if (loadedId === rec.id) await doUnload();
    try {
      await deleteLocalModel(rec);
      setTip(`已删除「${rec.name}」。文件已从手机里移除。`);
      await refresh();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setConfirmDel(null);
    }
  };

  const busy = busyId !== null;

  return (
    <View style={s.root}>
      <ScrollView style={s.body} contentContainerStyle={s.bodyC} keyboardShouldPersistTaps="handled">
        {/* ① 环境不可用时先说清原因与出路，别让用户对着灰按钮猜 */}
        {!avail.available ? (
          <View style={s.warn}>
            <Text style={s.warnHd}>当前环境跑不了本地模型</Text>
            <Text style={s.warnTx}>{avail.reason}</Text>
          </View>
        ) : null}

        {err ? (
          <View style={s.errBox}>
            <Text style={s.errTx}>{err}</Text>
          </View>
        ) : null}
        {tip ? (
          <View style={s.tipBox}>
            <Text style={s.tipTx}>{tip}</Text>
          </View>
        ) : null}

        {/* ② 问答在用哪个 */}
        <View style={s.card}>
          <View style={s.rowBetween}>
            <Text style={s.cardLb}>问答在用</Text>
            {loadedId ? (
              <View style={[s.pill, s.pillOn]}>
                <View style={s.dotOn} />
                <Text style={s.pillOnT}>已加载</Text>
              </View>
            ) : (
              <View style={s.pill}>
                <View style={s.dotOff} />
                <Text style={s.pillT}>未加载</Text>
              </View>
            )}
          </View>
          <Text style={s.bigName}>
            {loadedId ? installed.find((r) => r.id === loadedId)?.name || loadedId : '还没有加载任何本地模型'}
          </Text>
          {loadNote ? <Text style={s.note}>{loadNote}</Text> : null}
          <Text style={s.note}>
            {loadedId
              ? '同一时刻只留一个模型在内存里 —— 手机上装不下两个，切模型会自动释放上一个。'
              : '加载后才能把「我的 → 模型来源」切到「手机本地模型」。'}
          </Text>
          {loadedId ? (
            <Pressable style={[s.miniBtn, busy && s.miniBtnOff]} onPress={() => void doUnload()} disabled={busy}>
              <Text style={s.miniBtnT}>释放内存</Text>
            </Pressable>
          ) : null}
        </View>

        {/* ③ 本机检测 */}
        <Text style={s.sect}>本机检测</Text>
        <View style={s.detect}>
          <View style={s.detectCol}>
            <Text style={s.detectLb}>内存</Text>
            <Text style={s.detectV}>{totalMem ? formatBytes(totalMem) : '未知'}</Text>
            <Text style={s.detectU}>{avail.available ? TIER_LABEL[tier] : '当前运行环境'}</Text>
          </View>
          <View style={s.detectCol}>
            <Text style={s.detectLb}>估算可用</Text>
            <Text style={s.detectV}>{totalMem ? formatBytes(usableBytes(totalMem)) : '未知'}</Text>
            <Text style={s.detectU}>前台可用上限（估）</Text>
          </View>
          <View style={s.detectCol}>
            <Text style={s.detectLb}>剩余存储</Text>
            <Text style={s.detectV}>{free ? formatBytes(free) : '未知'}</Text>
            <Text style={s.detectU}>{avail.available ? '模型存沙盒' : '浏览器不支持'}</Text>
          </View>
        </View>
        {/* 环境不支持本地推理时，上面这几个数读的是**电脑的内存**（web 的 navigator.deviceMemory
            报的是宿主内存），拿它做选型建议会把人带沟里 —— 所以这时候不给建议，只说明。 */}
        <Text style={s.note}>
          {avail.available ? (
            `按这台手机，建议先装「${recommend.name}」（${formatBytes(recommend.bytes)}）。iOS 上内存超限是被系统直接杀掉、不会先变慢，所以「估算可用」这一栏比参数表更有参考价值。`
          ) : (
            '这些数字读的是当前运行环境（电脑浏览器 / Expo Go），不是你的手机 —— 装到自己构建的手机版里运行时，会自动按真机内存重新判定并给出建议。'
          )}
        </Text>

        {/* ④ 添加模型：三个入口 */}
        <Text style={s.sect}>添加模型</Text>
        <View style={s.seg}>
          {(
            [
              ['catalog', '在线下载'],
              ['nas', 'NAS 拉取'],
              ['file', '文件导入'],
            ] as [Entrance, string][]
          ).map(([k, label]) => (
            <Pressable key={k} style={[s.segItem, entrance === k && s.segItemOn]} onPress={() => setEntrance(k)}>
              <Text style={[s.segTx, entrance === k && s.segTxOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {entrance === 'catalog' ? (
          <View>
            <Pressable
              style={s.mirrorRow}
              onPress={() => updateSettings({ localMirror: !useMirror })}
            >
              <View style={[s.switch, useMirror && s.switchOn]}>
                <View style={[s.knob, useMirror && s.knobOn]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.mirrorT}>走国内镜像（hf-mirror.com）</Text>
                <Text style={s.mirrorU}>
                  {useMirror ? '当前：镜像源。国内直连 huggingface.co 大概率超时。' : '当前：官方源。只有在能直连 HuggingFace 时才这么选。'}
                </Text>
              </View>
            </Pressable>

            {MODEL_CATALOG.map((m) => {
              const fit = avail.available ? fitForModel(m.bytes, totalMem) : null;
              const has = installedIds.has(m.id);
              const thisBusy = busyId === m.id;
              return (
                <View key={m.id} style={[s.mCard, fit === 'no' && s.mCardNo]}>
                  <View style={s.rowBetween}>
                    <Text style={s.mName} numberOfLines={1}>
                      {m.name}
                    </Text>
                    {/* 「推荐」与「这台机器跑得动」都由内存档位推出来。
                        环境不支持本地推理时（web / Expo Go），内存读到的是电脑的，
                        结论会算错 —— 这时候干脆不显示，等真机再给判断。 */}
                    {avail.available && m.id === recommend.id ? (
                      <View style={s.recPill}>
                        <Text style={s.recPillT}>推荐</Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={s.mMetaRow}>
                    <Text style={s.kv}>{m.quant}</Text>
                    <Text style={s.kv}>{formatBytes(m.bytes)}</Text>
                    <Text style={s.kv}>{m.params}</Text>
                    {fit ? (
                      <Text style={[s.kv, fit === 'ok' && s.kvOk, fit === 'tight' && s.kvTight, fit === 'no' && s.kvNo]}>
                        {FIT_TEXT[fit]}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={s.mNote}>{m.note}</Text>

                  {thisBusy && prog ? (
                    <View style={{ marginTop: 10 }}>
                      <View style={s.bar}>
                        <View
                          style={[
                            s.barI,
                            { width: prog.ratio == null ? '22%' : `${Math.max(3, Math.round(prog.ratio * 100))}%` },
                          ]}
                        />
                      </View>
                      <Text style={s.note}>
                        {prog.ratio == null
                          ? `下载中… ${prog.downloaded ? formatBytes(prog.downloaded) + ' 已落盘' : '等待服务器响应'}`
                          : `下载中 ${Math.round(prog.ratio * 100)}% · ${formatBytes(prog.downloaded)} / ${formatBytes(prog.total)}`}
                      </Text>
                      {/* 取消：GB 级的下载一旦开始，以前只能等完或杀 App。
                          选错模型、或发现该走镜像源时，得有退出的办法。 */}
                      {isDownloading() ? (
                        <Pressable
                          style={[s.act, { marginTop: 8, alignSelf: 'flex-start' }]}
                          onPress={() => {
                            if (cancelActiveDownload()) setTip('正在取消…');
                          }}
                        >
                          <Text style={s.actT}>取消下载</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}

                  <View style={s.mActions}>
                    {has ? (
                      <View style={s.donePill}>
                        <Text style={s.donePillT}>已下载</Text>
                      </View>
                    ) : (
                      <Pressable
                        style={[s.act, (busy || !avail.available) && s.actOff]}
                        disabled={busy || !avail.available}
                        onPress={() => void runDownload(m)}
                      >
                        <Text style={s.actT}>{thisBusy ? '下载中…' : fit === 'no' ? '仍要下载' : '下载'}</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}
            <Text style={s.note}>
              体积是实测值（对下载地址取文件大小），量化等级与上下文长度会在下载完成后从文件头读出来核对。
            </Text>
          </View>
        ) : null}

        {entrance === 'nas' ? (
          <View style={s.card}>
            <Text style={s.cardLb}>从局域网拉取</Text>
            <Text style={s.note}>
              手机和 NAS 在同一个 WiFi 下最快，也不耗外网流量。把 .gguf 放在 NAS 上能被 HTTP 访问的目录里即可。
            </Text>
            <TextInput
              style={s.input}
              value={nasUrl}
              onChangeText={setNasUrl}
              placeholder="http://192.168.0.x:8788/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={s.input}
              value={nasName}
              onChangeText={setNasName}
              placeholder="存成什么名字（可留空，默认用文件名）"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {busyId === '__nas__' && prog ? (
              <View style={{ marginTop: 10, marginBottom: 6 }}>
                <View style={s.bar}>
                  <View
                    style={[
                      s.barI,
                      { width: prog.total > 0 && prog.ratio != null ? `${Math.max(3, Math.round(prog.ratio * 100))}%` : '22%' },
                    ]}
                  />
                </View>
                <Text style={s.note}>
                  {prog.ratio == null
                    ? `拉取中… ${prog.downloaded ? formatBytes(prog.downloaded) + ' 已落盘' : '等待 NAS 响应'}`
                    : `拉取中 ${Math.round(prog.ratio * 100)}%`}
                </Text>
                {isDownloading() ? (
                  <Pressable
                    style={[s.act, { marginTop: 8, alignSelf: 'flex-start' }]}
                    onPress={() => {
                      if (cancelActiveDownload()) setTip('正在取消…');
                    }}
                  >
                    <Text style={s.actT}>取消拉取</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <Pressable
              style={[s.act, s.actWide, (busy || !avail.available) && s.actOff]}
              disabled={busy || !avail.available}
              onPress={() => void runNasPull()}
            >
              <Text style={s.actT}>{busyId === '__nas__' ? '拉取中…' : '开始拉取'}</Text>
            </Pressable>
          </View>
        ) : null}

        {entrance === 'file' ? (
          <View style={s.card}>
            <Text style={s.cardLb}>从「文件」App 导入</Text>
            <Text style={s.note}>
              AirDrop、微信、iCloud 收下来的 <Text style={s.code}>.gguf</Text> 都走这里。导入时会先读文件头核对格式，
              不是 GGUF 就直接告诉你原因，不会把废文件塞进沙盒。
            </Text>
            <Pressable
              style={[s.act, s.actWide, (busy || !avail.available) && s.actOff]}
              disabled={busy || !avail.available}
              onPress={() => void runImport()}
            >
              <Text style={s.actT}>{busyId === '__file__' ? '选择中…' : '选择 .gguf 文件'}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ⑤ 已装模型 */}
        <Text style={s.sect}>已装模型{installed.length ? ` · ${installed.length}` : ''}</Text>
        {/* 浏览器预览会把几条演示条目写进 localStorage，好让这一屏有内容可看。
            必须点名，否则「已下载」会被当真 —— 那是在说谎。 */}
        {!avail.available && installed.length > 0 ? (
          <Text style={s.note}>
            下面这些是浏览器预览用的演示条目（文件并不存在），只为把这一屏的几种状态摆出来看。装到手机上运行时，这里只会列出你自己真正下载或导入的模型。
          </Text>
        ) : null}
        {listing ? (
          <View style={s.emptyRow}>
            <ActivityIndicator color={colors.primary} size="small" />
            <Text style={s.emptyTx}>正在扫描沙盒里的模型…</Text>
          </View>
        ) : installed.length === 0 ? (
          <View style={s.emptyBox}>
            <Text style={s.emptyTx}>还没有装任何本地模型。</Text>
            <Text style={s.note}>在线下载最省事；如果你已经有 .gguf 文件，用上面第三个入口导进来更快。</Text>
          </View>
        ) : (
          installed.map((r) => {
            const fit = avail.available ? fitForModel(r.bytes, totalMem) : null;
            const isLoaded = loadedId === r.id;
            const loading = busyId === `load:${r.id}`;
            const noMeta = !r.quant && !r.ctxFromFile;
            return (
              <View key={r.id} style={[s.iCard, isLoaded && s.iCardOn, fit === 'no' && s.mCardNo]}>
                <View style={s.rowBetween}>
                  <Text style={s.mName} numberOfLines={1}>
                    {r.name}
                  </Text>
                  {isLoaded ? (
                    <View style={[s.pill, s.pillOn]}>
                      <View style={s.dotOn} />
                      <Text style={s.pillOnT}>已加载</Text>
                    </View>
                  ) : (
                    <View style={s.pill}>
                      <View style={s.dotOff} />
                      <Text style={s.pillT}>已下载</Text>
                    </View>
                  )}
                </View>
                <View style={s.mMetaRow}>
                  <Text style={s.kv}>{r.quant || '未读到量化信息'}</Text>
                  <Text style={s.kv}>{formatBytes(r.bytes)}</Text>
                  <Text style={s.kv}>上下文 {r.ctxUse}</Text>
                  {r.source ? <Text style={s.kv}>{SOURCE_LABEL[r.source]}</Text> : null}
                </View>
                {noMeta ? (
                  <Text style={s.note}>
                    没能从文件头读出量化与上下文（文件可能不完整）。加载不一定失败，但这个文件值得先确认一下来源。
                  </Text>
                ) : null}
                {r.ctxFromFile && r.ctxFromFile < 4096 ? (
                  <Text style={s.note}>这个模型自带上下文只有 {r.ctxFromFile}，长资料问答会被截断。</Text>
                ) : null}
                {fit === 'no' ? <Text style={s.noteWarn}>{FIT_TEXT.no}</Text> : null}
                {fit === 'tight' ? <Text style={s.noteWarn}>{FIT_TEXT.tight}</Text> : null}

                <View style={s.mActions}>
                  {isLoaded ? (
                    <Pressable style={[s.actGhost, busy && s.actOff]} disabled={busy} onPress={() => void doUnload()}>
                      <Text style={s.actGhostT}>释放</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={[s.act, (busy || !avail.available) && s.actOff]}
                      disabled={busy || !avail.available}
                      onPress={() => void doLoad(r)}
                    >
                      <Text style={s.actT}>{loading ? '加载中…' : '加载'}</Text>
                    </Pressable>
                  )}

                  {/* 删除：二次确认，且只作用于这一个模型 */}
                  {confirmDel === r.id ? (
                    <>
                      <Pressable style={s.actDanger} disabled={busy} onPress={() => void doDelete(r)}>
                        <Text style={s.actDangerT}>确认删除</Text>
                      </Pressable>
                      <Pressable style={s.actGhost} onPress={() => setConfirmDel(null)}>
                        <Text style={s.actGhostT}>取消</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable style={s.actGhost} disabled={busy} onPress={() => setConfirmDel(r.id)}>
                      <Text style={s.actGhostT}>删除</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })
        )}

        {/* ⑥ 系统内置模型（只有支持的机型才有意义） */}
        <Text style={s.sect}>系统内置（机型受限）</Text>
        <View style={s.sysCard}>
          <View style={s.rowBetween}>
            <Text style={s.mName}>{SYSTEM_MODEL.name}</Text>
            {/* 徽章由真判断得出，不是写死的「本机不可用」：
                以前那句是常量，而同一屏又承诺「换上支持的机型会自动变可用」——
                代码里没有任何一处会因换机型而改变，等于界面在说一件不成立的事。 */}
            <View style={s.pill}>
              <View style={sysStatus.state === 'unsupported' ? s.dotOff : s.dotOn} />
              <Text style={s.pillT}>{sysStatus.label}</Text>
            </View>
          </View>
          <View style={s.mMetaRow}>
            <Text style={s.kv}>{SYSTEM_MODEL.approxParams}</Text>
            <Text style={s.kv}>零下载</Text>
            <Text style={s.kv}>零占用</Text>
          </View>
          <Text style={s.note}>{sysStatus.detail}</Text>
        </View>

        <Text style={s.foot}>
          模型一律后置下载，不打包进 App：安装包不会因此变大。删掉模型只影响本地推理，已导入的资料、索引与问答记录都不受影响。
        </Text>
        <View style={{ height: space.s4 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1 },
  bodyC: { padding: space.s3, paddingBottom: 8 },

  warn: { backgroundColor: colors.warnSoft, borderRadius: radius.lg, padding: 14, marginBottom: 12 },
  warnHd: { fontSize: 13.5, fontWeight: '700', color: colors.warn, marginBottom: 5 },
  warnTx: { fontSize: 12.5, color: '#6b4a12', lineHeight: 18 },

  errBox: { backgroundColor: colors.badSoft, borderRadius: radius.lg, padding: 13, marginBottom: 12 },
  errTx: { fontSize: 12.5, color: colors.bad, lineHeight: 18 },
  tipBox: { backgroundColor: colors.greenSoft, borderRadius: radius.lg, padding: 13, marginBottom: 12 },
  tipTx: { fontSize: 12.5, color: colors.green, lineHeight: 18 },

  card: { backgroundColor: colors.card, borderRadius: radius.xl, padding: 15, marginBottom: 12, ...shadow.card },
  cardLb: { fontSize: 11.5, fontWeight: '600', color: colors.muted },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  bigName: { fontSize: 16.5, fontWeight: '700', letterSpacing: -0.3, color: colors.text, marginTop: 9 },

  sect: { fontFamily: mono, fontSize: 10, letterSpacing: 1.4, color: colors.muted, textTransform: 'uppercase', marginTop: 6, marginBottom: 9, marginHorizontal: 2 },
  note: { fontFamily: mono, fontSize: 10.5, color: colors.faint, lineHeight: 16, marginTop: 7 },
  noteWarn: { fontFamily: mono, fontSize: 10.5, color: colors.warn, lineHeight: 16, marginTop: 7 },
  code: { fontFamily: mono, fontSize: 10.5, color: colors.inkSoft },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.borderSoft, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 5 },
  pillT: { fontFamily: mono, fontSize: 10, fontWeight: '700', color: colors.muted },
  pillOn: { backgroundColor: colors.greenSoft },
  pillOnT: { fontFamily: mono, fontSize: 10, fontWeight: '700', color: colors.green },
  dotOn: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#2fb763' },
  dotOff: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#c3c9d4' },

  detect: { flexDirection: 'row', gap: 9 },
  detectCol: { flex: 1, backgroundColor: colors.card, borderRadius: radius.lg, padding: 12, ...shadow.card },
  detectLb: { fontSize: 10.5, fontWeight: '600', color: colors.muted },
  detectV: { fontFamily: mono, fontSize: 16, fontWeight: '700', letterSpacing: -0.5, color: colors.text, marginTop: 6 },
  detectU: { fontFamily: mono, fontSize: 9, color: colors.faint, marginTop: 4, lineHeight: 13 },

  seg: { flexDirection: 'row', backgroundColor: colors.cardAlt, borderRadius: radius.md, padding: 3, gap: 3, marginBottom: 12 },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: radius.md - 3, alignItems: 'center' },
  segItemOn: { backgroundColor: colors.primary },
  segTx: { fontSize: 12.5, fontWeight: '600', color: colors.muted },
  segTxOn: { color: '#fff' },

  mirrorRow: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.card, borderRadius: radius.lg, padding: 13, marginBottom: 12, ...shadow.card },
  switch: { width: 40, height: 24, borderRadius: 12, backgroundColor: '#d8dce6', padding: 2, justifyContent: 'center' },
  switchOn: { backgroundColor: colors.primary },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  knobOn: { alignSelf: 'flex-end' },
  mirrorT: { fontSize: 13, fontWeight: '600', color: colors.text },
  mirrorU: { fontFamily: mono, fontSize: 10, color: colors.faint, marginTop: 3, lineHeight: 14 },

  mCard: { backgroundColor: colors.card, borderRadius: radius.xl, padding: 14, marginBottom: 10, ...shadow.card },
  mCardNo: { borderWidth: 1, borderColor: '#f6d5c6' },
  iCard: { backgroundColor: colors.card, borderRadius: radius.xl, padding: 14, marginBottom: 10, ...shadow.card },
  iCardOn: { borderWidth: 1.5, borderColor: '#cdcaff' },
  sysCard: { backgroundColor: colors.card, borderRadius: radius.xl, padding: 14, opacity: 0.82, ...shadow.card },
  mName: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600', letterSpacing: -0.1, color: colors.text },
  mMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  kv: { fontFamily: mono, fontSize: 9.5, color: colors.text2, backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4 },
  kvOk: { color: colors.green, backgroundColor: colors.greenSoft, borderColor: colors.greenSoft },
  kvTight: { color: colors.warn, backgroundColor: colors.warnSoft, borderColor: colors.warnSoft },
  kvNo: { color: colors.bad, backgroundColor: colors.badSoft, borderColor: colors.badSoft },
  mNote: { fontSize: 11.5, color: colors.muted, lineHeight: 16, marginTop: 8 },
  recPill: { backgroundColor: colors.primary, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 },
  recPillT: { fontFamily: mono, fontSize: 9.5, fontWeight: '700', color: '#fff' },
  donePill: { backgroundColor: colors.borderSoft, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 7 },
  donePillT: { fontFamily: mono, fontSize: 10.5, fontWeight: '700', color: colors.muted },

  bar: { height: 5, borderRadius: 3, backgroundColor: '#eceef4', overflow: 'hidden' },
  barI: { height: '100%', borderRadius: 3, backgroundColor: colors.primary },

  mActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12, alignItems: 'center' },
  act: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 15, paddingVertical: 8 },
  actWide: { flex: 1, alignItems: 'center', marginTop: 12 },
  actOff: { backgroundColor: colors.faint },
  actT: { fontSize: 12.5, fontWeight: '700', color: '#fff' },
  actGhost: { backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 13, paddingVertical: 8 },
  actGhostT: { fontSize: 12.5, fontWeight: '600', color: colors.text2 },
  actDanger: { backgroundColor: colors.bad, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 8 },
  actDangerT: { fontSize: 12.5, fontWeight: '700', color: '#fff' },
  // 「释放内存」这类就地小按钮：比 act* 更轻，不需要抢主视觉
  miniBtn: {
    alignSelf: 'flex-start', backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6, marginTop: 10,
  },
  miniBtnOff: { opacity: 0.45 },
  miniBtnT: { fontSize: 11.5, fontWeight: '600', color: colors.text2 },

  input: {
    fontFamily: mono, fontSize: 12, color: colors.text, backgroundColor: colors.cardAlt,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 11, paddingVertical: 10, marginTop: 10,
  },

  emptyRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 14, paddingHorizontal: 4 },
  emptyBox: { backgroundColor: colors.card, borderRadius: radius.xl, padding: 15, ...shadow.card },
  emptyTx: { fontSize: 12.5, color: colors.muted },

  foot: { fontFamily: mono, fontSize: 10, color: colors.faint, lineHeight: 15, marginTop: 16, marginHorizontal: 2 },
});
