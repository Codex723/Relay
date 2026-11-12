import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <EmptyState title="Page not found">
      <p>We could not find that page.</p>
      <Link href="/vendors" className="btn-primary mt-6">Browse vendors</Link>
    </EmptyState>
  );
}
