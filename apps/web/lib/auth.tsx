"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuthResponse, PublicUser } from "@relay/shared";
import { createApiClient, type ApiClient } from "./apiClient";
import { API_URL } from "./config";

type Status = "loading" | "anon" | "authed";

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

interface AuthContextValue {
  status: Status;
  user: PublicUser | null;
  /** Current access token (kept in memory only), for the live connection. */
  token: string | null;
  /** An API client that adds the token and refreshes it when it expires. */
  client: ApiClient;
  refresh: () => Promise<string | null>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const inflight = useRef<Promise<string | null> | null>(null);

  // The access token lives in memory only. The long-lived refresh token is an HttpOnly cookie the page cannot read.
  const bare = useMemo(() => createApiClient({ baseUrl: API_URL, getToken: () => null, refresh: async () => null }), []);

  const apply = useCallback((r: AuthResponse) => {
    tokenRef.current = r.accessToken;
    setToken(r.accessToken);
    setUser(r.user);
    setStatus("authed");
  }, []);
  const clear = useCallback(() => {
    tokenRef.current = null;
    setToken(null);
    setUser(null);
    setStatus("anon");
  }, []);

  // One refresh at a time, however many requests ask for it.
  const refresh = useCallback(() => {
    if (!inflight.current) {
      inflight.current = bare
        .post<AuthResponse>("/auth/refresh", undefined, { skipRefresh: true })
        .then((r) => {
          apply(r);
          return r.accessToken;
        })
        .catch(() => {
          clear();
          return null;
        })
        .finally(() => {
          inflight.current = null;
        });
    }
    return inflight.current;
  }, [apply, clear, bare]);

  const client = useMemo(() => createApiClient({ baseUrl: API_URL, getToken: () => tokenRef.current, refresh }), [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      token,
      client,
      refresh,
      login: async (email, password) => apply(await bare.post<AuthResponse>("/auth/login", { email, password }, { skipRefresh: true })),
      register: async (input) => apply(await bare.post<AuthResponse>("/auth/register", input, { skipRefresh: true })),
      logout: async () => {
        await bare.post("/auth/logout", undefined, { skipRefresh: true }).catch(() => undefined);
        clear();
      },
    }),
    [status, user, token, client, refresh, apply, clear, bare],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
