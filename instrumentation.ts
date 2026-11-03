export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MODEL_CHAT_SERVER_INSTANCE === String(process.pid)) {
    const { getAuth } = await import("./lib/auth");
    const { getStore } = await import("./lib/store");
    const { startFileJobs } = await import("./lib/file-jobs");
    await getAuth();
    startFileJobs(getStore());
  }
}
