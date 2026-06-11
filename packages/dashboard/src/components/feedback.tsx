/** Shared empty / error UI for list templates whose CLI read may fail or return nothing. */
import { LpError } from "../lib/run-launch-pad";

export function errorMessage(err: unknown): string {
  if (err instanceof LpError) return err.message || err.stderr.split("\n")[0] || "command failed";
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div class="alert alert-error" role="alert">
      <div>
        <div class="font-semibold">{title}</div>
        <div class="text-sm opacity-90 font-mono break-all">{message}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div class="text-center py-12 opacity-70">
      <div class="text-lg font-medium">{title}</div>
      <div class="text-sm mt-1">{message}</div>
    </div>
  );
}

/** Wraps a disabled control so tooltips work (browsers suppress title on disabled buttons). */
export function DisabledTip({
  reason,
  testId,
  children,
}: {
  reason: string;
  testId?: string;
  children: unknown;
}) {
  return (
    <span class="tooltip tooltip-left" data-tip={reason} data-testid={testId}>
      {children}
    </span>
  );
}
