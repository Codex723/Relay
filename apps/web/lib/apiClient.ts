export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiClientDeps {
  baseUrl: string;
  getToken: () => string | null;
  /** Gets a new access token using the refresh cookie, or null if the person is signed out. */
  refresh: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  /** Auth endpoints must not try to refresh on 401, or a wrong password would loop. */
  skipRefresh?: boolean;
}

export function createApiClient(deps: ApiClientDeps) {
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}, retried = false): Promise<T> {
    const token = deps.getToken();
    let res: Response;
    try {
      res = await doFetch(`${deps.baseUrl}${path}`, {
        method,
        credentials: "include",
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "NETWORK", "We could not reach the server. Check your connection and try again.");
    }

    if (res.status === 401 && !retried && !opts.skipRefresh) {
      const fresh = await deps.refresh();
      if (fresh) return request<T>(method, path, body, opts, true);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? "ERROR", err?.message ?? "Something went wrong. Please try again.");
    }
    return json as T;
  }

  return {
    get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
    post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body, opts),
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
