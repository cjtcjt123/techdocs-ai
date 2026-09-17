import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radius, space } from '../theme';
import { useStore } from '../store';
import { getChunks } from '../lib/storage';
import { Document, Chunk } from '../types';

export default function DocDetailScreen({ route }: { route: any }) {
  const { docId } = route.params;
  const { documents } = useStore();
  const doc: Document | undefined = documents.find((d) => d.id === docId);
  const [chunks, setChunks] = useState<Chunk[] | null>(null);

  useEffect(() => {
    getChunks(docId).then(setChunks);
  }, [docId]);

  if (!doc) return <View style={styles.center}><Text style={{ color: colors.muted }}>文档不存在</Text></View>;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.name}>{doc.name}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.meta}>{doc.type.toUpperCase()}</Text>
        <Text style={styles.meta}>状态：{doc.status}</Text>
        {doc.meta?.model ? <Text style={styles.meta}>型号：{doc.meta.model}</Text> : null}
      </View>

      <Text style={styles.h}>原文片段（{chunks ? chunks.length : 0} 段）</Text>
      {chunks === null ? (
        <ActivityIndicator />
      ) : chunks.length === 0 ? (
        <Text style={styles.empty}>该文档暂未解析出文本（PDF / Word 解析引擎后续接入）。</Text>
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
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s2, marginTop: space.s1, marginBottom: space.s3 },
  meta: { fontSize: 12, color: colors.muted },
  h: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  chunk: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.s3, marginBottom: space.s2 },
  chunkText: { fontSize: 13, color: colors.text, lineHeight: 19 },
  empty: { fontSize: 13, color: colors.muted },
});
