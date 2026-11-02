export const DEMO_IDS = ["budget", "writing", "explain"] as const;
export type DemoId = typeof DEMO_IDS[number];
export interface DemoSample {
  id: DemoId;
  title: string;
  description: string;
  prompt: string;
  file?: { name: string; content: string };
}
export const DEMOS: readonly DemoSample[] = [
  {
    id: "budget",
    title: "Explore a sample budget",
    description: "Compare planned and actual spending in a tiny synthetic CSV.",
    prompt: "Using sample-budget.csv, compare planned and actual spending. Give the total for each, identify the biggest overrun, and suggest one practical adjustment. Cite the file and keep the answer concise.",
    file: {
      name: "sample-budget.csv",
      content: "category,planned,actual\nGroceries,320,355\nTransport,120,95\nBooks,80,50\nEntertainment,100,145\n",
    },
  },
  {
    id: "writing",
    title: "Draft a friendly update",
    description: "Turn a few fictional project notes into a clear, short email.",
    prompt: "Write a friendly project-update email of no more than 100 words using these fictional notes: the first draft is ready; feedback is needed by Friday; the final version is planned for Monday. Include a clear subject and one specific request. Do not invent extra facts.",
  },
  {
    id: "explain",
    title: "Make a concept click",
    description: "Try a plain-language explanation with an everyday analogy.",
    prompt: "Explain why a password should be stored as a salted hash instead of plain text. Use a simple everyday analogy, then summarize the difference between hashing and encryption in three short bullets.",
  },
];
