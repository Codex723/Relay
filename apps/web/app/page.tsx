import Link from "next/link";

// A simple home screen for now. The cinematic scroll-driven hero replaces this in a later step.
export default function Home() {
  return (
    <section className="flex min-h-[70vh] flex-col items-start justify-center gap-6">
      <h1 className="font-display text-[22vw] leading-none tracking-wide sm:text-[12rem]">RELAY</h1>
      <p className="font-serif text-3xl italic text-muted sm:text-5xl">Move the city.</p>
      <p className="max-w-md text-muted">Order from vendors in Abuja and Lagos, pay in naira, and watch your rider arrive in real time.</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/vendors" className="btn-primary">Browse vendors</Link>
        <Link href="/orders" className="btn-ghost">My orders</Link>
      </div>
    </section>
  );
}
