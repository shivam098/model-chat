class HttpError extends Error {
  constructor(public status: number, message: string, options?: ErrorOptions, public code?: string) {
    super(message, options);
  }
}

// Instrumentation and route bundles share the store; preserve error identity across them.
const errors = globalThis as typeof globalThis & { modelChatAppError?: typeof HttpError };
export const AppError = errors.modelChatAppError ||= HttpError;
export type AppError = InstanceType<typeof AppError>;

export function errorResponse(error: unknown) {
  if (error instanceof AppError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  console.error("[model-chat] Request failed:", error instanceof Error ? error.name : "Unknown error");
  return Response.json({ error: "The request failed on this machine. Check the server console and try again." }, { status: 500 });
}
