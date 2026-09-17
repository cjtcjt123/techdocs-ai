import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import LibraryScreen from './src/screens/LibraryScreen';
import ChatScreen from './src/screens/ChatScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import { colors } from './src/theme';

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
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
            options={{ title: '资料库', tabBarLabel: '资料库' }}
          />
          <Tab.Screen
            name="Chat"
            component={ChatScreen}
            options={{ title: '问答', tabBarLabel: '问答' }}
          />
          <Tab.Screen
            name="Profile"
            component={ProfileScreen}
            options={{ title: '我的', tabBarLabel: '我的' }}
          />
        </Tab.Navigator>
      </NavigationContainer>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
