import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from '../lib/api.js';

const AuthContext = createContext(null);

// A non-secret marker that this browser has signed in before.  It only decides
// whether asking the server for a session is worth a request; a first-time
// visitor skips the refresh call (and its 401) entirely.
const SESSION_HINT = 'inkwell-signed-in';
const hint = {
  exists() {
    try {
      return localStorage.getItem(SESSION_HINT) === '1';
    } catch {
      return true; // storage unavailable: just ask the server
    }
  },
  set(present) {
    try {
      if (present) localStorage.setItem(SESSION_HINT, '1');
      else localStorage.removeItem(SESSION_HINT);
    } catch {
      // ignore
    }
  },
};

/**
 * Holds the signed-in user.  On page load the access token is gone (it only
 * ever lived in memory), so the provider asks the server to exchange the
 * httpOnly refresh cookie for a new one before rendering the app.
 */
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | signedIn | signedOut

  const clear = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('signedOut');
    hint.set(false);
    // Never show one person's cached journal to the next person on this device.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setSessionLostHandler(clear);
    if (!hint.exists()) {
      setStatus('signedOut');
      return undefined;
    }
    let cancelled = false;
    refreshSession()
      .then((session) => {
        if (cancelled) return;
        setUser(session.user);
        setStatus('signedIn');
      })
      .catch(() => {
        if (cancelled) return;
        hint.set(false);
        setStatus('signedOut');
      });
    return () => {
      cancelled = true;
    };
  }, [clear]);

  const startSession = useCallback((session) => {
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus('signedIn');
    hint.set(true);
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      setUser,
      async login(credentials) {
        startSession(await api('/auth/login', { method: 'POST', body: credentials }));
      },
      async register(details) {
        startSession(await api('/auth/register', { method: 'POST', body: details }));
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        clear();
      },
      /** After a password change the server issues a fresh token for this device. */
      replaceAccessToken: setAccessToken,
      clear,
    }),
    [user, status, startSession, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
