import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors, radius, space } from '../theme';
import Button from '../components/Button';

// MVP 占位：资料库列表 + 文档卡 + 导入入口（后续接文件导入与索引）
export default function LibraryScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>资料库</Text>
      <Text style={styles.sub}>导入 PDF / Word / Markdown，建立本地索引</Text>

      <View style={styles.card}>
        <Text style={styles.docName}>示例：Araldite CY1578 TDS.pdf</Text>
        <View style={[styles.badge, { backgroundColor: colors.greenSoft }]}>
          <Text style={[styles.badgeText, { color: colors.green }]}>已索引</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.docName}>示例：环氧树脂检测报告.docx</Text>
        <View style={[styles.badge, { backgroundColor: colors.amberSoft }]}>
          <Text style={[styles.badgeText, { color: colors.amber }]}>索引中</Text>
        </View>
      </View>

      <View style={styles.action}>
        <Button label="导入文档" onPress={() => {}} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.s3, backgroundColor: colors.background, flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.muted, marginTop: space.s1, marginBottom: space.s3 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.s3,
    marginBottom: space.s2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  docName: { fontSize: 15, color: colors.text, flexShrink: 1, marginRight: space.s2 },
  badge: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  action: { marginTop: space.s2 },
});
