import { z } from "zod";
import type { Config } from "../config";

export interface InitializeInput {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
}
export interface InitializeResult {
  authorizationUrl: string;
  reference: string;
}
export interface VerifyResult {
  status: string;
  amountKobo: number;
  currency: string;
  reference: string;
  raw: unknown;
}

// A small interface so tests (and later steps) can swap in a fake instead of calling Paystack.
export interface PaystackClient {
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
}

export class PaystackError extends Error {}

const InitData = z.object({ authorization_url: z.string().url(), reference: z.string() });
const VerifyData = z.object({
  status: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  reference: z.string(),
});

const BASE_URL = "https://api.paystack.co";

export function createPaystackClient(config: Config): PaystackClient {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PaystackError("Could not reach Paystack.");
    }
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: unknown } | null;
    if (!res.ok || !json?.status) throw new PaystackError(`Paystack error (${res.status}): ${json?.message ?? "no message"}`);
    return json.data;
  }

  return {
    async initialize({ email, amountKobo, reference, callbackUrl }) {
      const data = InitData.parse(
        await call("/transaction/initialize", {
          method: "POST",
          body: JSON.stringify({ email, amount: amountKobo, currency: "NGN", reference, callback_url: callbackUrl }),
        }),
      );
      return { authorizationUrl: data.authorization_url, reference: data.reference };
    },
    async verify(reference) {
      const raw = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
      const data = VerifyData.parse(raw);
      return { status: data.status, amountKobo: data.amount, currency: data.currency, reference: data.reference, raw };
    },
  };
}
