import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const origin = "http://127.0.0.1:3211";

test("dark by default; light is remembered per browser; the lamp effect stays still for reduced motion and on phones", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  await expect(page.locator(".auth-page .lamp")).toHaveAttribute("data-mode", "live");

  const response = await page.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email: `theme-${randomUUID().slice(0, 8)}@example.test`, password: "Synthetic theme pass 5521" } });
  expect(response.status()).toBe(200);
  await page.goto("/");
  await expect(page.locator(".main-panel.empty .lamp")).toHaveAttribute("data-mode", "live");
  await page.getByRole("button", { name: /Account & connection/ }).first().click();
  const themes = page.getByRole("group", { name: "Theme" });
  await expect(themes.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  await themes.getByRole("button", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  await page.getByRole("button", { name: /Account & connection/ }).first().click();
  await expect(themes.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  await themes.getByRole("button", { name: "Dark" }).click();
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Another browser profile keeps its own choice (the default).
  const other = await browser.newContext({ baseURL: origin, reducedMotion: "reduce" });
  try {
    const visitor = await other.newPage();
    await visitor.goto("/");
    await expect(visitor.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(visitor.locator(".auth-page .lamp")).toHaveAttribute("data-mode", "static");
  } finally { await other.close(); }
  const phone = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const visitor = await phone.newPage();
    await visitor.goto("/");
    await expect(visitor.locator(".auth-page .lamp")).toHaveAttribute("data-mode", "static");
  } finally { await phone.close(); }
});
