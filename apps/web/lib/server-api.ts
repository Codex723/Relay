import { ApiError } from "./apiClient";
import { API_URL } from "./config";

// For server components. Data is never cached so open/closed and availability are always current.
export async function serverGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  } catch {
    throw new ApiError(0, "NETWORK", "We could not reach the server.");
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, json?.error?.code ?? "ERROR", json?.error?.message ?? "Something went wrong.");
  }
  return (await res.json()) as T;
}
