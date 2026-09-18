import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, mono, radius, shadow, space } from '../theme';
import { useStore } from '../store';
import { biometricAuth, biometricInfo, type BiometricInfo } from '../lib/biometric';

// 隐私锁。
//
// 三个和以前不一样的地方，都有具体理由：
//  ① 密码 4 位 → 6 位。输入方式一并改成「六格圆点 + 自绘数字键盘」——
//     原来是靠系统数字键盘打一个输入框，手指要瞄输入框、键盘弹起还挤掉半屏。
//  ② 真接上面容：进来先自己刷一次脸，通过了直接进；没通过落到密码，不打断。
//     以前这个界面就是全部 —— 设置里那个「Face ID」开关背后没有一行生物识别代码。
//  ③ 出错就地说明（第几次、还剩几次），不再用 Alert —— Alert 在 web 预览上根本不弹，
//     等于错误被静默吞掉。
const LEN = 6;

export default function LockScreen() {
  const { passcodeSet, unlock, unlockByBiometric, setPasscode, settings } = useStore();
  // 上下留白必须走安全区，不能写死：iPhone 的 Home 指示条占 34px、灵动岛机型顶部另有 47px，
  // 写死 26/58 的话「删除」键会落进指示条里（手指点得到、但系统与手势区冲突，且看着像被切掉）。
  // 用 Math.max 兜底是因为 web 预览里 insets 恒为 0 —— 直接用的话浏览器里会顶到屏幕最上沿，
  // 而 web 预览是唯一能反复看这个界面的地方，不能为了真机把它搞坏。
  const insets = useSafeAreaInsets();
  const padTop = Math.max(insets.top, Platform.OS === 'ios' ? 40 : 24);
  const padBottom = Math.max(insets.bottom, 16);

  // 设置流程分两步：先输一遍，再输一遍确认
  const [firstPin, setFirstPin] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');

  const [bio, setBio] = useState<BiometricInfo | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioTries, setBioTries] = useState(0);
  // 自动刷脸只自动试一次：失败了还反复弹脸，用户会以为 App 卡住了
  const autoTried = useRef(false);

  useEffect(() => {
    let alive = true;
    void biometricInfo().then((r) => { if (alive) setBio(r); });
    return () => { alive = false; };
  }, []);

  const bioUsable = !!bio?.available && settings.privacy.biometric;

  const runBio = useCallback(async () => {
    setBioBusy(true);
    setErr('');
    const ok = await biometricAuth('解锁「京美AI助手」');
    setBioBusy(false);
    if (ok) { unlockByBiometric(); return; }
    setBioTries((n) => n + 1);
    setErr(`${bio?.label || '面容'}没认出来${bioTries ? `（第 ${bioTries + 1} 次）` : ''}。再试一次，或者直接输密码。`);
  }, [bio?.label, bioTries, unlockByBiometric]);

  // 已设密码 + 开了面容 + 硬件可用 → 自动刷一次
  useEffect(() => {
    if (!passcodeSet || !bioUsable || autoTried.current) return;
    autoTried.current = true;
    void runBio();
  }, [passcodeSet, bioUsable, runBio]);

  const press = (d: string) => {
    if (bioBusy) return;
    setErr('');
    setCode((c) => (c.length >= LEN ? c : c + d));
  };
  const back = () => { setErr(''); setCode((c) => c.slice(0, -1)); };

  // 输满 6 位就自动提交，不用再点「确定」—— iOS 上密码键盘没有确定键
  useEffect(() => {
    if (code.length !== LEN) return;
    const done = code;
    setCode('');
    if (!passcodeSet) {
      if (firstPin === null) { setFirstPin(done); return; }
      if (firstPin !== done) { setFirstPin(null); setErr('两次输入不一致，重来一次。'); return; }
      void setPasscode(done).catch((e: any) => setErr(e?.message || '设置失败'));
      return;
    }
    if (!unlock(done)) setErr('密码不对，再试一次。');
  }, [code, passcodeSet, firstPin, setPasscode, unlock]);

  const setting = !passcodeSet;
  const title = setting ? (firstPin === null ? '设置访问密码' : '再输一次') : '已锁定';
  const sub = setting
    ? firstPin === null
      ? `6 位数字。用来在启动时锁住这个 App —— 资料与提问都在手机里，值得上一道锁。`
      : '确认一遍，免得记错。'
    : bioBusy
      ? `${bio?.label || '面容'}验证中…`
      : `看一眼，或者输入 6 位密码`;

  return (
    <View style={[s.container, { paddingTop: padTop, paddingBottom: padBottom }]}>
      <View style={s.brandWrap}>
        <View style={s.logo}><Text style={s.logoT}>京</Text></View>
        <Text style={s.brand}>京美AI助手</Text>
      </View>

      {/* 面容只在「解锁」这一步有意义；设置密码时还不需要刷脸 */}
      {!setting && (
        <View style={s.faceWrap}>
          <View style={[s.faceRing, !bioUsable && { borderColor: colors.faint }]}>
            <View style={[s.faceBox, !bioUsable && { borderColor: colors.faint }]}>
              <View style={[s.eye, !bioUsable && { backgroundColor: colors.faint }]} />
              <View style={[s.eye, s.eyeR, !bioUsable && { backgroundColor: colors.faint }]} />
            </View>
            <View style={s.faceTag}>
              <Text style={s.faceTagT}>
                {bioBusy ? '面容验证中…' : bioUsable ? '点一下重试' : '不可用'}
              </Text>
            </View>
          </View>
        </View>
      )}

      <Text style={s.h}>{title}</Text>
      <Text style={s.sub}>{sub}</Text>

      <View style={s.dots}>
        {Array.from({ length: LEN }).map((_, i) => (
          <View key={i} style={[s.dot, i < code.length && s.dotOn]} />
        ))}
      </View>

      {!!err && <Text style={s.err}>{err}</Text>}

      {/* 面容不可用时就直说为什么 —— 缺了这句，用户只会以为 App 坏了 */}
      {!setting && !bioUsable && !!bio?.reason && <Text style={s.hint}>{bio.reason}</Text>}

      {!setting && (
        <Pressable onPress={runBio} disabled={!bioUsable || bioBusy} style={s.bioLink}>
          <Text style={[s.bioLinkT, (!bioUsable || bioBusy) && { color: colors.faint }]}>
            {bioBusy ? '正在验证…' : `用${bio?.label || '面容'}解锁`}
          </Text>
        </Pressable>
      )}

      <View style={s.kbd}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Pressable key={d} style={s.key} onPress={() => press(d)}>
            <Text style={s.keyT}>{d}</Text>
          </Pressable>
        ))}
        <Pressable
          style={[s.key, s.keyGhost]}
          onPress={runBio}
          disabled={!bioUsable || bioBusy}
        >
          <Text style={[s.keyGhostT, (!bioUsable || bioBusy) && { opacity: 0.35 }]}>
            {bio?.label?.includes('面容') ? '面容' : '指纹'}
          </Text>
        </Pressable>
        <Pressable style={s.key} onPress={() => press('0')}>
          <Text style={s.keyT}>0</Text>
        </Pressable>
        <Pressable style={[s.key, s.keyGhost]} onPress={back}>
          <Text style={s.keyGhostT}>删除</Text>
        </Pressable>
      </View>

      {setting && (
        <Text style={s.hint}>
          {bio?.available
            ? `设置完可以直接用${bio.label}解锁，不用输密码。`
            : bio?.reason || ''}
        </Text>
      )}
    </View>
  );
}

const KEY_W = 88;
const s = StyleSheet.create({
  // paddingTop / paddingBottom 由组件按安全区动态覆盖（见上方 useSafeAreaInsets 的注释）
  container: { flex: 1, backgroundColor: colors.background, alignItems: 'center', paddingHorizontal: space.s4 },
  brandWrap: { alignItems: 'center' },
  logo: {
    width: 56, height: 56, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#8ea6f7',
    shadowColor: '#7882dc', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },
  logoT: { color: '#fff', fontSize: 24, fontWeight: '700' },
  brand: { marginTop: 12, fontSize: 14, fontWeight: '700', color: colors.text2, letterSpacing: 0.2 },

  faceWrap: { marginTop: 30, marginBottom: 6, alignItems: 'center' },
  faceRing: { width: 74, height: 74, borderRadius: 37, borderWidth: 2, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  faceBox: { width: 30, height: 30, borderWidth: 2.5, borderColor: colors.primary, borderRadius: 8, position: 'relative' },
  eye: { position: 'absolute', left: 5, top: 8, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
  eyeR: { left: undefined, right: 5 },
  faceTag: { position: 'absolute', bottom: -10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  faceTagT: { fontFamily: mono, fontSize: 9.5, fontWeight: '700', color: colors.primary },

  h: { marginTop: 26, fontSize: 24, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: colors.muted, textAlign: 'center', marginTop: 8, lineHeight: 19, maxWidth: 300 },

  dots: { flexDirection: 'row', gap: 13, marginTop: 28 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: '#c9cedb' },
  dotOn: { backgroundColor: colors.text, borderColor: colors.text },

  err: { marginTop: 18, backgroundColor: '#fdeceb', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 13, fontFamily: mono, fontSize: 11.5, color: colors.red, maxWidth: 320, textAlign: 'center' },
  hint: { marginTop: 16, fontFamily: mono, fontSize: 10.5, lineHeight: 16, color: colors.faint, textAlign: 'center', maxWidth: 320 },

  bioLink: { marginTop: 16, paddingVertical: 8, paddingHorizontal: 12 },
  bioLinkT: { fontSize: 13, fontWeight: '600', color: colors.primary },

  // 自绘数字键盘：固定列宽而不是 flex 均分，这样三列在任何屏宽下都对齐
  kbd: { flexDirection: 'row', flexWrap: 'wrap', width: KEY_W * 3 + 22, gap: 11, marginTop: 'auto' },
  key: { width: KEY_W, height: 52, borderRadius: 13, backgroundColor: colors.cardAlt, alignItems: 'center', justifyContent: 'center', ...shadow.card },
  keyT: { fontFamily: mono, fontSize: 21, fontWeight: '600', color: colors.text },
  keyGhost: { backgroundColor: 'transparent', shadowOpacity: 0, elevation: 0 },
  keyGhostT: { fontSize: 13, fontWeight: '600', color: colors.muted },
});
