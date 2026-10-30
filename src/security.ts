import { AsyncLocalStorage } from "node:async_hooks";

const providerLogScope = new AsyncLocalStorage<boolean>();
// The pinned NetEase SDK logs whole response objects, including Set-Cookie, on
// error. Install once; never swap console around individual concurrent requests.
// AsyncLocalStorage keeps unrelated Bridge request logs unaffected.
for (const method of ["log", "error", "warn", "info", "debug"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    if (!providerLogScope.getStore()) original(...args);
  };
}

export function withoutProviderLogs<T>(operation: () => Promise<T>): Promise<T> {
  return providerLogScope.run(true, operation);
}

export class SafeOperationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

// Never forward upstream exception text: it may contain headers, response bodies,
// login challenges, chat text or credentials. Keep stable operation/error codes.
export function safeError(error: unknown, fallback = "operation_failed"): string {
  if (error instanceof SafeOperationError) return error.code;
  if (error && typeof error === "object" && "operation" in error && "code" in error) {
    const operation = String(error.operation);
    const code = Number(error.code);
    if (/^[a-z_]{1,80}$/i.test(operation)) {
      return operation + (error.code !== null && Number.isFinite(code) ? ` code=${code}` : " failed");
    }
  }
  return fallback;
}
