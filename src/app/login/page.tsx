'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Eye, EyeOff, KeyRound } from 'lucide-react';
import { CaptchaModal } from '@/components/auth/CaptchaModal';
import {
  checkWelcomeRequirement,
  fetchCurrentUser,
  signInWithDeviceApiKey,
  signInWithPassword,
} from '@/lib/api';
import { safeRemoveLocalStorageItem } from '@/lib/browser-storage';
import {
  clearDeviceCredential,
  getMokeDeviceIdentity,
  storeDeviceCredential,
  supportsPersistentDeviceCredential,
} from '@/lib/device-auth';
import { clearCurrentAccountMokeCache } from '@/lib/moke-cache';
import { requestAnimatedBack } from '@/lib/native-back';
import { useServerStore } from '@/lib/store/server';

type LoginMode = 'password' | 'api_key';

export default function LoginPage() {
  const router = useRouter();
  const { logout, serverTitle, setConnected } = useServerStore();
  const [mode, setMode] = useState<LoginMode>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [deviceApiKeySupported, setDeviceApiKeySupported] = useState(
    useServerStore.getState().capabilities.deviceApiKeyApi,
  );
  const [persistentStorage, setPersistentStorage] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);
  const { serverUrl } = useServerStore.getState();

  useEffect(() => {
    let cancelled = false;
    void supportsPersistentDeviceCredential().then((supported) => {
      if (!cancelled) setPersistentStorage(supported);
    });
    if (serverUrl) {
      void checkWelcomeRequirement(serverUrl).then((welcome) => {
        if (cancelled) return;
        setDeviceApiKeySupported(welcome.deviceApiKeyApi);
        const current = useServerStore.getState().capabilities;
        useServerStore.getState().setServerCapabilities({
          ...current,
          passwordLoginApi: welcome.passwordLoginApi,
          deviceApiKeyApi: welcome.deviceApiKeyApi,
        });
      });
    }
    return () => { cancelled = true; };
  }, [serverUrl]);

  const handleLogin = async (captchaData?: any) => {
    if (mode === 'password' && (!username.trim() || !password.trim())) return;
    if (mode === 'api_key' && !apiKey.trim()) return;
    setLoading(true);
    setError('');

    try {
      const identity = mode === 'password' && rememberDevice
        ? await getMokeDeviceIdentity()
        : null;
      const response = mode === 'password'
        ? await signInWithPassword({
          username,
          password,
          rememberDevice,
          deviceId: identity?.id,
          deviceName: identity?.name,
          captchaData,
        })
        : await signInWithDeviceApiKey(apiKey.trim());

      if (response.err === 'ok') {
        setShowCaptcha(false);
        const info = await fetchCurrentUser();
        if (!info.isLogin || !info.user) {
          logout();
          setError('登录请求已成功，但服务器没有建立登录状态。请检查当前服务器是否允许保存 Cookie。');
          return;
        }

        try {
          await clearCurrentAccountMokeCache();
        } catch (cacheError) {
          console.warn('[LoginPage] failed to clear stale account cache:', cacheError);
        }
        if (rememberDevice) {
          const token = mode === 'password' ? response.api_key : apiKey.trim();
          if (token) {
            await storeDeviceCredential(serverUrl, {
              apiKey: token,
              accountUsername: info.user.username,
              keyInfo: response.api_key_info || null,
            });
          } else {
            await clearDeviceCredential(serverUrl);
          }
        } else {
          await clearDeviceCredential(serverUrl);
        }
        safeRemoveLocalStorageItem('moke-auth-token');
        setConnected('', info.user);
        router.push('/shelf');
      } else if (response.err === 'not_invited' || response.err === 'user.private.not_valid') {
        router.replace('/access');
      } else if (
        mode === 'password'
        && (response.err === 'captcha.invalid' || response.err === 'captcha.expired' || response.err === 'captcha.required')
      ) {
        setError(response.msg || '请输入人机验证码');
        setShowCaptcha(true);
      } else {
        setError(response.msg || (mode === 'api_key' ? 'API Key 无效或已吊销' : '登录失败，请检查用户名和密码'));
      }
    } catch (loginError) {
      console.error('[LoginPage] login flow failed:', loginError);
      setError('无法连接服务器');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (nextMode: LoginMode) => {
    setMode(nextMode);
    setError('');
    setShowCaptcha(false);
    setShowSecret(false);
  };

  return (
    <main className="flex min-h-screen items-center justify-center app-warm-bg px-4">
      <div className="relative my-8 w-full max-w-[430px] overflow-hidden rounded-[32px] app-glass p-8 sm:p-10">
        <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative">
          <button type="button" onClick={() => requestAnimatedBack('/')} aria-label="返回" className="absolute -left-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full bg-muted transition-colors hover:bg-muted/80">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div className="mb-7 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/15">
              <BookOpen className="h-7 w-7 text-primary-foreground" />
            </div>
          </div>

          <h1 className="text-center text-[22px] font-bold text-foreground">登录</h1>
          <p className="mb-6 mt-2 text-center text-sm text-muted-foreground">欢迎回到 {serverTitle || '书库'}</p>

          {deviceApiKeySupported && (
            <div className="mb-5 grid grid-cols-2 rounded-xl border border-amber-950/10 bg-white/45 p-1" role="group" aria-label="登录方式">
              <button type="button" aria-pressed={mode === 'password'} onClick={() => switchMode('password')} className={`min-h-10 rounded-lg text-sm font-medium transition ${mode === 'password' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60'}`}>账号密码</button>
              <button type="button" aria-pressed={mode === 'api_key'} onClick={() => switchMode('api_key')} className={`min-h-10 rounded-lg text-sm font-medium transition ${mode === 'api_key' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60'}`}>API Key</button>
            </div>
          )}

          {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

          <form onSubmit={(event) => { event.preventDefault(); void handleLogin(); }} className="flex flex-col gap-4">
            {mode === 'password' ? (
              <>
                <div>
                  <label htmlFor="login-username" className="mb-1.5 block text-sm font-medium text-foreground">用户名</label>
                  <input id="login-username" name="username" required type="text" placeholder="请输入用户名" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" className="h-11 w-full rounded-xl border border-amber-950/10 bg-white/65 px-4 text-[16px] sm:text-sm text-foreground shadow-sm outline-none transition-shadow focus:ring-2 focus:ring-ring" />
                </div>
                <SecretField label="密码" placeholder="请输入密码" value={password} onChange={setPassword} show={showSecret} onToggle={() => setShowSecret(!showSecret)} autoComplete="current-password" />
              </>
            ) : (
              <SecretField label="设备 API Key" placeholder="moke_tk1_..." value={apiKey} onChange={setApiKey} show={showSecret} onToggle={() => setShowSecret(!showSecret)} autoComplete="off" icon />
            )}

            {deviceApiKeySupported && <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-950/10 bg-white/40 px-3.5 py-3">
              <input type="checkbox" checked={rememberDevice} onChange={(event) => setRememberDevice(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">记住此设备</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {persistentStorage === false ? '当前平台仅在本次运行中保留密钥，不保存密码。' : '密钥保存在系统安全存储中，不保存密码。'}
                </span>
              </span>
            </label>}

            <button type="submit" disabled={loading} className="mt-1 h-11 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-lg shadow-primary/15 transition hover:opacity-90 active:opacity-80 disabled:opacity-50">
              {loading ? '登录中...' : '登录'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            还没有账号？ <Link href="/register" data-dom-id="link-register" className="font-medium text-primary hover:underline">注册</Link>
            <span className="mx-2 text-border">|</span>
            <Link href="/reset-password" className="font-medium text-primary hover:underline">忘记密码？</Link>
          </p>

          <CaptchaModal isOpen={showCaptcha} serverUrl={serverUrl} onClose={() => setShowCaptcha(false)} onSuccess={(data) => void handleLogin(data)} />
        </div>
      </div>
    </main>
  );
}

function SecretField({ label, placeholder, value, onChange, show, onToggle, autoComplete, icon = false }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
  autoComplete: string;
  icon?: boolean;
}) {
  const inputId = useId();
  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      <div className="relative">
        {icon && <KeyRound className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />}
        <input id={inputId} name={icon ? 'api_key' : 'password'} required type={show ? 'text' : 'password'} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} spellCheck={false} className={`h-11 w-full rounded-xl border border-amber-950/10 bg-white/65 pr-11 text-[16px] sm:text-sm text-foreground shadow-sm outline-none transition-shadow focus:ring-2 focus:ring-ring ${icon ? 'pl-10' : 'pl-4'}`} />
        <button type="button" onClick={onToggle} aria-label={show ? `隐藏${label}` : `显示${label}`} title={show ? `隐藏${label}` : `显示${label}`} className="absolute right-0.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground">
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
