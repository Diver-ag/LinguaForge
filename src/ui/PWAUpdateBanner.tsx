import React, { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, Sparkles, X } from 'lucide-react';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes in background
const VISIBILITY_THROTTLE_MS = 5 * 60 * 1000; // Throttle visibility checks to 5 minutes

export const PWAUpdateBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const userRequestedReloadRef = useRef(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const lastCheckRef = useRef<number>(Date.now());
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      registrationRef.current = registration;

      // If a waiting service worker is already downloaded and waiting, surface banner immediately
      if (registration.waiting) {
        setNeedRefresh(true);
      }

      const checkForUpdate = () => {
        const reg = registrationRef.current;
        if (!reg || reg.installing) return;
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        lastCheckRef.current = Date.now();
        reg.update().catch(() => {
          // Ignore transient offline/network errors during background update check
        });
      };

      const intervalId = window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          const elapsed = Date.now() - lastCheckRef.current;
          if (elapsed >= VISIBILITY_THROTTLE_MS) {
            checkForUpdate();
          }
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);

      cleanupListenersRef.current?.();
      cleanupListenersRef.current = () => {
        window.clearInterval(intervalId);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    },
    onNeedRefresh() {
      setDismissed(false);
      setNeedRefresh(true);
    },
    onNeedReload() {
      // Never auto-reload unless the user explicitly clicked the Reload button in this tab
      if (userRequestedReloadRef.current) {
        window.location.reload();
      }
    },
    onRegisterError(error) {
      console.warn('Service worker registration error:', error);
    },
  });

  useEffect(() => {
    return () => {
      cleanupListenersRef.current?.();
    };
  }, []);

  if (!needRefresh || dismissed) {
    return null;
  }

  const handleReloadToUpdate = async () => {
    if (isUpdating) return;
    setIsUpdating(true);
    userRequestedReloadRef.current = true;

    try {
      await updateServiceWorker(true);
    } catch {
      // Fall through to reload fallback below
    }

    // Safety fallback if controllerchange / controlling didn't trigger reload promptly
    window.setTimeout(() => {
      if (userRequestedReloadRef.current) {
        window.location.reload();
      }
    }, 2000);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 right-4 md:bottom-5 md:right-5 z-50 max-w-sm rounded-2xl bg-[var(--surface)] border border-indigo-500/40 shadow-2xl px-4 py-3 flex items-center gap-3 text-xs animate-in fade-in slide-in-from-bottom-2"
    >
      <div className="w-8 h-8 rounded-xl bg-[var(--accent-subtle)] text-[var(--accent-text)] flex items-center justify-center shrink-0">
        <Sparkles className="w-4 h-4" />
      </div>

      <p className="font-semibold text-[var(--text)] leading-snug flex-1">
        New version available. Reload to update
      </p>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={handleReloadToUpdate}
          disabled={isUpdating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold text-xs shadow-sm transition active:scale-95"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
          <span>{isUpdating ? 'Updating...' : 'Reload'}</span>
        </button>

        <button
          type="button"
          onClick={() => setDismissed(true)}
          disabled={isUpdating}
          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)] transition"
          aria-label="Dismiss update notification"
          title="Dismiss for now"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
