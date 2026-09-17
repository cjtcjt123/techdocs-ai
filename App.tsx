import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, Text, View } from 'react-native';
import LibraryScreen from './src/screens/LibraryScreen';
import ChatScreen from './src/screens/ChatScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import DocDetailScreen from './src/screens/DocDetailScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import LockScreen from './src/components/LockScreen';
import { colors } from './src/theme';
import { useStore } from './src/store';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Tab 图标：不配 tabBarIcon 时 React Navigation 会回落渲染它自带的 MissingIcon（⏷ 占位三角）。
// 这里统一用 emoji 字形——不依赖任何图标字体，原生与 web 表现一致。
type IconProps = { color: string; size: number };
const tabIcon = (glyph: string) => ({ size }: IconProps) => (
  <Text style={{ fontSize: size, lineHeight: size + 2 }}>{glyph}</Text>
);

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600' },
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
      }}
    >
      <Tab.Screen
        name="Library"
        component={LibraryScreen}
        options={{ title: '资料库', tabBarIcon: tabIcon('📚') }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: '问答', tabBarIcon: tabIcon('💬') }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ title: '我的', tabBarIcon: tabIcon('👤') }}
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
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="DocDetail" component={DocDetailScreen} options={{ title: '文档详情' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: '更多设置' }} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
