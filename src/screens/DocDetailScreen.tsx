import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radius, space } from '../theme';
import { useStore } from '../store';
import { getChunks } from '../lib/storage';
import { Document, Chunk, DocStatus } from '../types';

const STATUS_LABEL: Record<DocStatus, string> = {
  indexing: '索引中', indexed: '已索引', partial: '无文本', failed: '失败',
};
const SOURCE_LABEL: Record<string, string> = {
  nas: 'NAS 解析服务', local: '手机本地', none: '未提取',
};

export default function DocDetailScreen({ route }: { route: any }) {
  const { docId } = route.params;
  const { documents } = useStore();
  const doc: Document | undefined = documents.find((d) => d.id === docId);
  const [chunks, setChunks] = useState<Chunk[] | null>(null);

  useEffect(() => {
    getChunks(docId).then(setChunks);
  }, [docId]);

  if (!doc) return <View style={styles.center}><Text style={{ color: colors.muted }}>文档不存在</Text></View>;

  const m = doc.meta || {};

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.name}>{doc.name}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.meta}>{doc.type.toUpperCase()}</Text>
        <Text style={styles.meta}>状态：{STATUS_LABEL[doc.status]}</Text>
        {m.model ? <Text style={styles.meta}>型号：{m.model}</Text> : null}
        {m.pages ? <Text style={styles.meta}>{m.pages} 页</Text> : null}
        {typeof m.chars === 'number' ? <Text style={styles.meta}>{m.chars} 字</Text> : null}
      </View>

      {m.parseSource ? (
        <View style={styles.metaRow}>
          <Text style={styles.meta}>
            解析：{SOURCE_LABEL[m.parseSource] || m.parseSource}
            {typeof m.parseQuality === 'number' ? ` · 质量 ${m.parseQuality}` : ''}
          </Text>
        </View>
      ) : null}

      {m.note ? (
        <View style={styles.noteBox}>
          <Text style={styles.noteText}>
            {doc.status === 'indexed' ? 'ℹ️ ' : '⚠️ '}{m.note}
          </Text>
        </View>
      ) : null}

      <Text style={styles.h}>原文片段（{chunks ? chunks.length : 0} 段）</Text>
      {chunks === null ? (
        <ActivityIndicator />
      ) : chunks.length === 0 ? (
        <Text style={styles.empty}>没提取到文本，这份资料的内容搜不到。</Text>
      ) : (
        chunks.map((c) => (
          <View key={c.id} style={styles.chunk}>
            <Text style={styles.chunkText}>{c.content}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.s3, backgroundColor: colors.background, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 20, fontWeight: '700', color: colors.text },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s2, marginTop: space.s1, marginBottom: space.s1 },
  meta: { fontSize: 12, color: colors.muted },
  noteBox: { backgroundColor: colors.amberSoft, borderRadius: radius.sm, padding: space.s2, marginTop: space.s2, marginBottom: space.s3 },
  noteText: { fontSize: 12, color: colors.text, lineHeight: 18 },
  h: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: space.s2, marginBottom: space.s2 },
  chunk: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.s3, marginBottom: space.s2 },
  chunkText: { fontSize: 13, color: colors.text, lineHeight: 19 },
  empty: { fontSize: 13, color: colors.muted },
});
