import { AuthShell } from "@/components/auth-shell";
import { ForgotPasswordForm } from "@/components/forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your work email and we'll send you a link to set a new password."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
