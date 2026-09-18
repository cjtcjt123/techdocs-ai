// Tab 图标：用 View 画几何块，零依赖（不引 react-native-svg，也不引图标字体）。
// 每个图标定义在 16×16 的逻辑网格上，按 size 等比缩放 —— 原生与 web 表现一致。
import React from 'react';
import { View } from 'react-native';

export type GlyphName = 'work' | 'lib' | 'chat' | 'cmp' | 'gear' | 'me';

// [x, y, w, h, r]
const SHAPES: Record<GlyphName, Array<[number, number, number, number, number]>> = {
  // 工作台：Bento 网格（大小不等即优先级）
  work: [
    [0, 0, 7, 7, 2],
    [9, 0, 7, 4, 2],
    [9, 6, 7, 10, 2],
    [0, 9, 7, 7, 2],
  ],
  // 资料库：两本并排的书
  lib: [
    [2, 0.5, 5, 15, 1.6],
    [9, 2, 5, 12, 1.6],
  ],
  // 问答：气泡（矩形 + 左下角小尾巴）
  chat: [[0, 0, 16, 12, 4.2]],
  // 对比：两根不等高竖条
  cmp: [
    [2, 2, 4.6, 12, 1.8],
    [9.4, 2, 4.6, 7, 1.8],
  ],
  // 环 + 中心点：这两个不在这里画，走下面的特殊分支。
  // gear = 设置入口；me = 底栏的「我的」—— 同一个形状，它要表达的就是「设置都在这」。
  gear: [],
  me: [],
};

export default function TabGlyph({ name, color, size = 22 }: { name: GlyphName; color: string; size?: number }) {
  const u = size / 16;
  return (
    <View style={{ width: size, height: size }}>
      {SHAPES[name].map(([x, y, w, h, r], i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: x * u,
            top: y * u,
            width: w * u,
            height: h * u,
            borderRadius: r * u,
            backgroundColor: color,
          }}
        />
      ))}
      {/* 设置 / 我的：环 + 中心点 */}
      {name === 'gear' || name === 'me' ? (
        <>
          <View
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: Math.max(1.6, size * 0.11),
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: size * 0.33,
              top: size * 0.33,
              width: size * 0.34,
              height: size * 0.34,
              borderRadius: size * 0.17,
              backgroundColor: color,
            }}
          />
        </>
      ) : null}
      {/* 气泡尾巴 */}
      {name === 'chat' ? (
        <View
          style={{
            position: 'absolute',
            left: 2 * u,
            top: 10 * u,
            width: 5 * u,
            height: 5 * u,
            borderRadius: 1 * u,
            backgroundColor: color,
            transform: [{ rotate: '45deg' }],
          }}
        />
      ) : null}
    </View>
  );
}
