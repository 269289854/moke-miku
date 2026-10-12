'use client';

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { fetchImageObjectUrl } from '@/lib/api';
import { buildCoverThumbUrl } from '@/lib/cover-url';
import { subscribeNetworkRecovery } from '@/lib/network-health';

const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

interface AuthImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** 完整的图片 URL（已通过 resolveServerAssetUrl 拼好） */
  src: string;
  /** 加载失败时渲染的回退内容（如占位封面） */
  fallback?: React.ReactNode;
  /** 是否优先使用服务器生成的缩略图（失败时回退原图） */
  thumb?: boolean;
  /** 显式回退图 URL（thumb 为 true 时被原始 src 覆盖） */
  fallbackSrc?: string;
}

/**
 * 带认证的图片组件。
 *
 * - Web 端：服务器与前端同源，cookie 会自动随 <img> 发送，直接用原生 <img>。
 * - Tauri 端：前端在 tauri:// 协议下，与 http(s):// 服务器跨源，<img> 不会带 session，
 *   会 401。因此改用 fetchImageObjectUrl 走带认证的 tauriFetch 拉取后转 blob URL。
 */
export function AuthImage({
  src,
  fallback,
  thumb,
  fallbackSrc,
  alt = '',
  loading,
  ...imgProps
}: AuthImageProps) {
  const primarySrc = thumb ? buildCoverThumbUrl(src) : src;
  const effectiveFallbackSrc = thumb
    ? (primarySrc !== src ? src : undefined)
    : fallbackSrc;

  // Web 端状态
  const [webFailed, setWebFailed] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [prevWebSrc, setPrevWebSrc] = useState(src);

  if (prevWebSrc !== src) {
    setPrevWebSrc(src);
    setWebFailed(false);
    setUsingFallback(false);
  }

  // Tauri 端状态
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [prevTauriSrc, setPrevTauriSrc] = useState(src);
  const [retryTrigger, setRetryTrigger] = useState(0);

  if (prevTauriSrc !== src) {
    setPrevTauriSrc(src);
    setFailed(false);
  }

  const currentObjectUrl = useRef<string | null>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const retriedForSrcRef = useRef<string | null>(null);

  // 懒加载：进入可视区附近才加载，loading="eager" 或无环境支持时立即加载
  const [inView, setInView] = useState(() => {
    if (!isTauriApp) return true;
    if (loading === 'eager') return true;
    if (typeof IntersectionObserver === 'undefined') return true;
    return false;
  });

  useEffect(() => {
    if (inView) return;
    if (loading === 'eager') {
      setInView(true);
      return;
    }
    const el = sentinelRef.current?.parentElement;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [inView, loading]);

  // Tauri 端图片加载
  useEffect(() => {
    if (!isTauriApp || !src || /^(blob:|data:)/i.test(src) || !inView) return;

    const controller = new AbortController();
    const signal = controller.signal;

    const load = async () => {
      // 1. 尝试主图（缩略图或原图）
      try {
        const url = await fetchImageObjectUrl(primarySrc, { signal });
        if (signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        if (currentObjectUrl.current) URL.revokeObjectURL(currentObjectUrl.current);
        currentObjectUrl.current = url;
        setObjectUrl(url);
        setFailed(false);
        return;
      } catch {
        if (signal.aborted) return;
      }

      // 2. 主图失败且有回退图 → 改加载回退图
      if (effectiveFallbackSrc) {
        try {
          const url = await fetchImageObjectUrl(effectiveFallbackSrc, { signal });
          if (signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          if (currentObjectUrl.current) URL.revokeObjectURL(currentObjectUrl.current);
          currentObjectUrl.current = url;
          setObjectUrl(url);
          setFailed(false);
          return;
        } catch {
          if (signal.aborted) return;
        }
      }

      // 3. 仍失败 → 释放上一张并标记失败
      if (currentObjectUrl.current) {
        URL.revokeObjectURL(currentObjectUrl.current);
        currentObjectUrl.current = null;
      }
      setObjectUrl(null);
      setFailed(true);
    };

    void load();

    return () => {
      controller.abort();
    };
  }, [src, primarySrc, effectiveFallbackSrc, inView, retryTrigger]);

  // 网络恢复时自动重试一次（每个 src 最多一次，重试前清掉失败状态）
  useEffect(() => {
    if (!isTauriApp || !failed) return;
    if (retriedForSrcRef.current === src) return;

    const unsubscribe = subscribeNetworkRecovery(() => {
      if (retriedForSrcRef.current === src) return;
      retriedForSrcRef.current = src;
      setFailed(false);
      setRetryTrigger((v) => v + 1);
    });

    return () => {
      unsubscribe();
    };
  }, [failed, src]);

  // 组件卸载时释放最后一张 blob
  useEffect(() => {
    return () => {
      if (currentObjectUrl.current) {
        URL.revokeObjectURL(currentObjectUrl.current);
        currentObjectUrl.current = null;
      }
    };
  }, []);

  // Web 端：直接用原生 <img>（同源自动带 cookie）
  if (!isTauriApp || /^(blob:|data:)/i.test(src)) {
    if (!src || webFailed) return <>{fallback ?? null}</>;
    const currentWebSrc = usingFallback && effectiveFallbackSrc ? effectiveFallbackSrc : primarySrc;
    const handleWebError = () => {
      if (effectiveFallbackSrc && !usingFallback) {
        setUsingFallback(true);
      } else {
        setWebFailed(true);
      }
    };
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={currentWebSrc}
        alt={alt}
        loading={loading}
        onError={handleWebError}
        {...imgProps}
      />
    );
  }

  // Tauri 端
  const tauriContent = (failed || !src || !objectUrl) ? (
    <>{fallback ?? null}</>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={objectUrl} alt={alt} loading={loading} {...imgProps} />
  );

  return (
    <>
      {tauriContent}
      <span ref={sentinelRef} hidden aria-hidden="true" />
    </>
  );
}
