"use client";

import { ErrorState } from "@/components/ui";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState message="We could not load this page. Check your connection and try again." onRetry={reset} />;
}
