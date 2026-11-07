import type { InitializeInput, PaystackClient, VerifyResult } from "../payments/paystack";

// A stand-in for Paystack that records calls and can be told to fail or to report a payment.
export function createFakePaystack() {
  const initializeCalls: InitializeInput[] = [];
  const state = {
    failInitialize: false,
    failVerify: false,
    verifyResult: null as VerifyResult | null,
  };
  const client: PaystackClient = {
    async initialize(input) {
      initializeCalls.push(input);
      if (state.failInitialize) throw new Error("fake paystack is down");
      return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, reference: input.reference };
    },
    async verify(reference) {
      if (state.failVerify) throw new Error("fake paystack is down");
      if (!state.verifyResult) {
        return { status: "abandoned", amountKobo: 0, currency: "NGN", reference, raw: { status: "abandoned" } };
      }
      return { ...state.verifyResult, reference };
    },
  };
  return { client, initializeCalls, state };
}
