import React from 'react';
import { View, Text, Switch, ScrollView, StyleSheet } from 'react-native';
import { colors, radius, space } from '../theme';

// MVP 占位：模型管理 / 隐私锁 / 存储（后续接 API 配置与 Face ID）
export default function ProfileScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>我的</Text>

      <View style={styles.card}>
        <Text style={styles.rowLabel}>模型模式</Text>
        <Text style={styles.value}>在线优先（云端 API）</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.rowLabel}>隐私锁（Face ID）</Text>
        <Switch value={false} />
      </View>

      <View style={styles.card}>
        <Text style={styles.rowLabel}>索引管理</Text>
        <Text style={styles.value}>—</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.rowLabel}>存储占用</Text>
        <Text style={styles.value}>—</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.s3, backgroundColor: colors.background, flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: space.s3 },
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
  rowLabel: { fontSize: 15, color: colors.text },
  value: { fontSize: 13, color: colors.muted },
});
