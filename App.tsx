import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import WorkbenchScreen from './src/screens/WorkbenchScreen';
import LibraryScreen from './src/screens/LibraryScreen';
import ChatScreen from './src/screens/ChatScreen';
import CompareScreen from './src/screens/CompareScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import DocDetailScreen from './src/screens/DocDetailScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ModelsScreen from './src/screens/ModelsScreen';
import LockScreen from './src/components/LockScreen';
import ConfirmCloudModal from './src/components/ConfirmCloudModal';
import TabGlyph, { GlyphName } from './src/components/TabGlyph';
import { colors, mono } from './src/theme';
import { useStore } from './src/store';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Tab 图标：不配 tabBarIcon 时 React Navigation 会回落渲染它自带的 MissingIcon（⏷ 占位三角）。
// 这里用 View 画几何块（TabGlyph）—— 不引 react-native-svg，也不引图标字体，原生与 web 表现一致。
//
// 文字也放进 tabBarIcon、配合 tabBarShowLabel:false 自己画，不用库的 label：
// 库的 label 在 web 上是个 flexShrink:1 的子项，同层还有两个 28px 高的兄弟块把它挤到 4px，
// 汉字被 overflow:hidden 切掉下半截（只调 lineHeight 会挤得更狠，实测 14px 反而塌成 4px）。
// 一个 View 同管图标与文字，高度不再由别人的布局说了算。
type IconProps = { color: string; focused: boolean; size: number };
const tabIcon =
  (glyph: GlyphName, title: string) =>
  ({ color, size }: IconProps) => (
    <View style={styles.tabItem}>
      <TabGlyph name={glyph} color={color} size={size} />
      {/* lineHeight 必须显式给：只给 fontSize 时行盒按字体度量算，会小于汉字的字身高度而被裁掉 */}
      <Text style={[styles.tabLabel, { color }]}>{title}</Text>
    </View>
  );

function Tabs() {
  // 底部 Tab 栏的高度必须自己带上安全区：写死高度会同时踩两个坑 ——
  // ① web 上 inset 为 0，栏底就是屏幕底；② 真机 iPhone 上文字会落进 Home 指示条那 34px 里。
  // 让 paddingBottom 与 height 一起加 inset，内容盒高度恒定（66+inset-10-8-inset = 48），
  // 多出来的 inset 只当作底部留白，web 与真机的相对布局就完全一致。
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      // 显式给 id：@react-navigation v7 的类型在没传 id 时会把 `id` 推成【必填】，
      // 两个重载全部报 "Property 'id' is missing"。补上就恢复正常，运行时它只是导航器标识。
      id="tabs"
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600' },
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 66 + insets.bottom,
          paddingTop: 10,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        // 文字由 tabIcon 自己画（见上方注释），库的 label 关掉，避免它那个会被压缩的盒子参与排版
        tabBarShowLabel: false,
      }}
    >
      {/* tabBarAccessibilityLabel 要显式给：文字改成自绘后，读屏就不再自动拿到标签名了 */}
      <Tab.Screen
        name="Workbench"
        component={WorkbenchScreen}
        options={{ title: '工作台', headerShown: false, tabBarAccessibilityLabel: '工作台', tabBarIcon: tabIcon('work', '工作台') }}
      />
      {/* 资料库/问答屏自绘了标题栏，再留系统 header 会出现两个「资料库」 */}
      <Tab.Screen
        name="Library"
        component={LibraryScreen}
        options={{ title: '资料库', headerShown: false, tabBarAccessibilityLabel: '资料库', tabBarIcon: tabIcon('lib', '资料库') }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: '问答', headerShown: false, tabBarAccessibilityLabel: '问答', tabBarIcon: tabIcon('chat', '问答') }}
      />
      <Tab.Screen
        name="Compare"
        component={CompareScreen}
        options={{ title: '对比', headerShown: false, tabBarAccessibilityLabel: '对比', tabBarIcon: tabIcon('cmp', '对比') }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  const { ready, init, locked, settings } = useStore();

  useEffect(() => { init(); }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // 隐私锁：开启了 Face ID 密码且当前锁定 → 显示锁屏
  if (settings.privacy.faceID && locked) {
    return (
      <SafeAreaProvider>
        <LockScreen />
        <StatusBar style="dark" />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1 }}>
        <NavigationContainer>
          <Stack.Navigator id="root">
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            {/* 「我的」放在 Stack 里（不是 Tab）：4 个 Tab 才不挤，而且 push 进来自带返回箭头。
                入口在工作台顶栏的「设置」胶囊；旧的 navigate('Profile') 依旧有效（会冒泡到父 Stack）。 */}
            <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: '我的' }} />
            <Stack.Screen name="DocDetail" component={DocDetailScreen} options={{ title: '文档详情' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: '更多设置' }} />
            {/* 本地模型管理：从「我的 → 手机本地模型」进。单独一屏而不是塞进设置里 ——
                这里要下载 GB 级文件、要逐项删除确认，塞进设置页会又长又难用。 */}
            <Stack.Screen name="Models" component={ModelsScreen} options={{ title: '手机本地模型' }} />
          </Stack.Navigator>
        </NavigationContainer>
        {/* 全局确认弹窗：同层里排在导航之后 = 盖在最上层。
            任何页面发起的云端调用都弹到它，不需要每页各挂一个（漏一页就等于漏一条外发路径）。 */}
        <ConfirmCloudModal />
      </View>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabItem: { alignItems: 'center', justifyContent: 'center' },
  // lineHeight 不能省，见 tabIcon 上方注释
  tabLabel: { marginTop: 3, fontSize: 10, lineHeight: 14, fontWeight: '600', fontFamily: mono },
});
