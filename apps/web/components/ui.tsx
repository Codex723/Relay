import type { ReactNode } from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-surface ${className}`} aria-hidden="true" />;
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="glass mx-auto max-w-lg p-8 text-center">
      <h2 className="font-display text-2xl tracking-wide">{title}</h2>
      {message && <p className="mt-2 text-muted">{message}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-primary mt-6">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="glass mx-auto max-w-lg p-8 text-center">
      <h2 className="font-display text-2xl tracking-wide">{title}</h2>
      {children && <div className="mt-3 text-muted">{children}</div>}
    </div>
  );
}
