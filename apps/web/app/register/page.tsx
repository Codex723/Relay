import { Suspense } from "react";
import { RegisterForm } from "./RegisterForm";

export const metadata = { title: "Create account | RELAY" };

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
