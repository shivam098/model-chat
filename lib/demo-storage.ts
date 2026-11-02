import { DEMOS, type DemoId } from "./demos";
import { AppError } from "./errors";
import type { Store } from "./store";

export function createDemoChat(store: Store, userId: string, demoId: DemoId, previous?: { chatId?: string; draft: string }) {
  const sample = DEMOS.find(demo => demo.id === demoId);
  if (!sample) throw new AppError(400, "Unknown sample.");
  return store.db.transaction(() => {
    if (previous && (previous.chatId || previous.draft)) {
      const prior = previous.chatId ? store.chat(userId, previous.chatId) : store.createChat(userId);
      if (!previous.chatId) store.renameChat(userId, prior.id, "Saved draft");
      store.saveDraft(userId, prior.id, previous.draft);
    }
    const created = store.createChat(userId);
    store.renameChat(userId, created.id, sample.title);
    store.saveDraft(userId, created.id, sample.prompt);
    if (sample.file) {
      // This fixed, synthetic UTF-8 fixture uses the same owned file/context storage as an upload.
      store.addFile(userId, created.id, sample.file.name, Buffer.from(sample.file.content, "utf8"), sample.file.content, "Synthetic UTF-8 CSV example. No personal data.");
    }
    return {
      detail: {
        chat: store.chat(userId, created.id),
        messages: store.messages(userId, created.id),
        attachments: store.attachments(userId, created.id),
      },
      chats: store.listChats(userId),
    };
  })();
}
