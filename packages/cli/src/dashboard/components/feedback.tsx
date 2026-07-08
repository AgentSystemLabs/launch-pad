/** Shared empty / error UI for pages whose CLI read may fail or return nothing. */
import { LpError } from "../cli-driver";

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

export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div class="text-center py-12 opacity-70">
      <div class="text-lg font-medium">{title}</div>
      <div class="text-sm mt-1">{message}</div>
    </div>
  );
}
