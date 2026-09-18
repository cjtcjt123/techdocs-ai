import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { colors, radius, space } from '../theme';
import { useStore } from '../store';

// 没有 PDF：手机上生成 PDF 要引入排版/字体子系统（新依赖 + 拖累出包流水线），
// 而 iOS 分享面板里「打印 → 存储为 PDF」本来就能一步得到。做不到的选项不摆在界面上 ——
// 摆着就是一个「改了没反应」的空壳开关。
const formats = [
  { key: 'markdown', label: 'Markdown' },
  { key: 'csv', label: 'CSV' },
] as const;

export default function SettingsScreen() {
  const { settings, updateSettings, documents, cases, embeddingCount, embeddingTotal } = useStore();
  const total = documents.length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>更多设置</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>导出格式（默认）</Text>
        <View style={styles.seg}>
          {formats.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => updateSettings({ exportFormat: f.key })}
              style={[styles.segItem, settings.exportFormat === f.key && styles.segItemOn]}
            >
              <Text style={[styles.segText, settings.exportFormat === f.key && styles.segTextOn]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.note}>
          作用于「需求符合性检查」结果的导出（对比页与问答页共用这一处设置，两边的表头因此始终一致）。
          对话记录是叙述性内容，固定导出 Markdown。需要 PDF 就用系统分享面板里的「打印 → 存储为 PDF」。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>数据管理</Text>
        <Text style={styles.row}>资料：{total} 份</Text>
        <Text style={styles.row}>经验案例：{cases.length} 条</Text>
        <Text style={styles.row}>语义索引：{embeddingCount}{embeddingTotal ? ` / ${embeddingTotal}` : ''} 块</Text>
        <Text style={styles.note}>
          批量删除：资料库页点右上角「选择」，逐项勾选后处理（弹窗会列出将删除的文件名，需二次确认）。
          语义索引的进度与「整库重建」在「我的 → 语义检索（嵌入服务）」里。
        </Text>
        <Text style={styles.note}>
          备份：目前只能导出对话与检查结果；资料本体与经验案例暂无一键导出。
          资料丢了重新导入即可，但经验案例是手工积累、丢了不可再生 —— 需要跨设备同步请告诉我。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>关于</Text>
        <Text style={styles.row}>京美AI助手 · MVP-0</Text>
        <Text style={styles.note}>
          架构：手机本地存储（SQLite）为主，模型双源（官方 API / 手机本地 GGUF），
          NAS 作为可选的解析、向量与同步后端 —— 三处都不配置也能完整离线使用。
        </Text>
        <Text style={styles.note}>
          已支持：PDF / Word / TXT / Markdown 解析入库 · 混合检索（BM25 关键词 + 向量语义 + RRF 融合）·
          多会话问答与来源引用 · 问答内临时附件 · 需求符合性检查与导出 · 个人经验库（记录后回灌进问答）。
        </Text>
        <Text style={styles.note}>
          尚未支持：扫描件 OCR（图片型 PDF 提不出文字，会标成「无文本」）· Excel / PPT / 网页导入 ·
          多设备同步 · 账号与权限（后端已就绪，App 端尚未接入）。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.s3, backgroundColor: colors.background, flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: space.s3 },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.s3, marginBottom: space.s2 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  seg: { flexDirection: 'row', backgroundColor: colors.background, borderRadius: radius.sm, padding: 3, gap: 3 },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: radius.sm - 2, alignItems: 'center' },
  segItemOn: { backgroundColor: colors.primary },
  segText: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  segTextOn: { color: '#fff' },
  note: { fontSize: 12, color: colors.muted, marginTop: space.s2, lineHeight: 17 },
  row: { fontSize: 14, color: colors.text, paddingVertical: space.s1 },
});
