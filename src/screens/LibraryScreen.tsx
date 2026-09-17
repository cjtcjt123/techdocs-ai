import React, { useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, Alert } from 'react-native';
import { colors, radius, space } from '../theme';
import Button from '../components/Button';
import { useStore } from '../store';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DocStatus } from '../types';

const statusMeta: Record<DocStatus, { label: string; bg: string; fg: string }> = {
  indexing: { label: '索引中', bg: colors.primarySoft, fg: colors.primary },
  indexed: { label: '已索引', bg: colors.greenSoft, fg: colors.green },
  partial: { label: '待解析', bg: colors.amberSoft, fg: colors.amber },
  failed: { label: '失败', bg: colors.redSoft, fg: colors.red },
};

export default function LibraryScreen() {
  const { documents, importFiles, importing, removeDoc, renameDoc } = useStore();
  const navigation = useNavigation<NativeStackNavigationProp<any>>();

  const onLongPress = (id: string, name: string) => {
    Alert.alert(name, '选择操作', [
      { text: '查看详情', onPress: () => navigation.navigate('DocDetail', { docId: id }) },
      { text: '重命名', onPress: () => {
        Alert.prompt('重命名', '', (t) => t && renameDoc(id, t));
      } },
      { text: '删除', style: 'destructive', onPress: () => removeDoc(id) },
      { text: '取消', style: 'cancel' },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <Text style={styles.title}>资料库</Text>
        <Text style={styles.sub}>{documents.length} 份文档 · 本地存储</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
        {documents.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>还没有资料。点下方「导入文档」开始。</Text>
            <Text style={styles.emptyHint}>支持 PDF / Word / Markdown / TXT（PDF·Word 解析引擎后续接入，先入库元数据）。</Text>
          </View>
        )}
        {documents.map((d) => {
          const m = statusMeta[d.status];
          return (
            <Pressable
              key={d.id}
              onPress={() => navigation.navigate('DocDetail', { docId: d.id })}
              onLongPress={() => onLongPress(d.id, d.name)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.docName} numberOfLines={1}>{d.name}</Text>
                <Text style={styles.docMeta}>{d.type.toUpperCase()}{d.meta?.model ? ` · ${d.meta.model}` : ''}</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: m.bg }]}>
                <Text style={[styles.badgeText, { color: m.fg }]}>{m.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.action}>
        <Button label={importing ? '导入中…' : '＋ 导入文档'} onPress={importFiles} disabled={importing} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  head: { paddingHorizontal: space.s3, paddingTop: space.s3, paddingBottom: space.s2 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.muted, marginTop: 2 },
  list: { flex: 1 },
  listInner: { paddingHorizontal: space.s3, paddingBottom: space.s2 },
  empty: { paddingVertical: space.s4, alignItems: 'center' },
  emptyText: { fontSize: 14, color: colors.text, marginBottom: 6 },
  emptyHint: { fontSize: 12, color: colors.muted, textAlign: 'center', paddingHorizontal: space.s4 },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: space.s3, marginBottom: space.s2, flexDirection: 'row', alignItems: 'center',
  },
  docName: { fontSize: 15, color: colors.text, marginBottom: 2 },
  docMeta: { fontSize: 12, color: colors.muted },
  badge: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10, marginLeft: space.s2 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  action: { padding: space.s3, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
});
