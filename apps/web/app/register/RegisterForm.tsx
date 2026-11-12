"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { safeNext } from "@/lib/orderStatus";

export function RegisterForm() {
  const { status, register } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authed") router.replace(next);
  }, [status, next, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ name: name.trim(), email: email.trim(), password, ...(phone.trim() ? { phone: phone.trim() } : {}) });
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account.");
      setBusy(false);
    }
  }

  return (
    <div className="glass mx-auto max-w-md p-8">
      <h1 className="font-display text-4xl tracking-wide">Create account</h1>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <div>
          <label htmlFor="name" className="label">Full name</label>
          <input id="name" name="name" autoComplete="name" required className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="phone" className="label">Phone (optional)</label>
          <input id="phone" name="phone" type="tel" autoComplete="tel" className="field" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password" className="label">Password (at least 10 characters)</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy || !name || !email || password.length < 10}>{busy ? "Creating account…" : "Create account"}</button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Already have an account? <Link className="text-accent" href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </div>
  );
}
