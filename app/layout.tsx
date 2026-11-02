import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Model Chat",
  description: "A quiet place for your models, conversations and files. Personal and local.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
