import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Button from './Button';
import { colors, mono, radius, shadow, space } from '../theme';
import { useStore } from '../store';

/**
 * 「云端调用需确认」的全局弹窗。
 *
 * 为什么放全局（挂在 App 根）而不是各页各写一个：确认可能从问答、对比页、
 * 语义索引重建、导入解析、NAS 浏览等任何一条路径发起。散在各页迟早会漏一条，
 * 而漏掉的那一条正是「资料静默外发」—— 用户开了保护却没被保护，且完全看不出来。
 * 挂在根上就只有一处，新增调用路径不可能绕过。
 */
export default function ConfirmCloudModal() {
  const pending = useStore((s) => s.pendingConfirm);
  const answer = useStore((s) => s.answerConfirm);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);

  if (!pending) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <Text style={styles.title}>资料要发到外部服务</Text>
        <Text style={styles.body}>{pending.what}</Text>
        <Text style={styles.note}>
          只在目标地址不属于你的内网时才会询问（NAS、192.168.x 这类地址不会打扰你）。
          选「取消」则这一步不发出任何内容。
        </Text>
        <Button label="允许这次" onPress={() => answer(true)} />
        <Button
          label="取消（不发出去）"
          variant="ghost"
          onPress={() => answer(false)}
          style={{ marginTop: space.s2 }}
        />
        <Pressable
          style={styles.never}
          onPress={() => {
            void updateSettings({ privacy: { ...settings.privacy, cloudConfirm: false } });
            answer(true);
          }}
        >
          <Text style={styles.neverText}>以后不再询问（关掉「云端调用需确认」）</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: space.s3,
  },
  card: {
    width: '100%', maxWidth: 380,
    backgroundColor: colors.surface, borderRadius: radius.md, padding: space.s3,
    ...shadow.card,
  },
  title: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: space.s2 },
  // 等宽字体：这里会回显实际要发往的地址，形近字符在比例字体里很难逐字核对
  body: { fontFamily: mono, fontSize: 12.5, color: colors.text, lineHeight: 20, marginBottom: space.s2 },
  note: { fontSize: 11.5, color: colors.muted, lineHeight: 17, marginBottom: space.s3 },
  never: { paddingVertical: space.s3, alignItems: 'center' },
  neverText: { fontSize: 12, color: colors.muted },
});
