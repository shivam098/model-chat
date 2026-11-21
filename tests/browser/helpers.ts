import { expect, type Page } from "@playwright/test";

/** The model button in the message box (it opens the model and thinking menu). */
export const modelButton = (page: Page) => page.getByRole("button", { name: /^Model: / });
/** Chooses a model (by id) and optionally a thinking level in the message box's model menu, then closes it. */
export async function selectModel(page: Page, id: string, thinking?: string) {
  await modelButton(page).click();
  const menu = page.getByRole("dialog", { name: "Model and thinking" });
  await menu.locator("label.model-option").filter({ has: page.locator(`input[name="model"][value="${id}"]`) }).click();
  await expect(menu.locator(`input[name="model"][value="${id}"]`)).toBeChecked();
  if (thinking) await chooseThinking(page, thinking);
  if (await menu.count()) await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}
/** Clicks a thinking level in the open model menu (choosing a level closes the menu). */
export async function chooseThinking(page: Page, level: string) {
  const menu = page.getByRole("dialog", { name: "Model and thinking" });
  await menu.locator(".thinking-levels label").filter({ has: page.locator(`input[value="${level}"]`) }).locator("span").click();
  await expect(modelButton(page)).toHaveAttribute("data-thinking", level);
}
/** The model ids offered in the message box's model menu. */
export async function modelOptions(page: Page) {
  await modelButton(page).click();
  const ids = await page.locator('.model-menu input[name="model"]').evaluateAll(items => items.map(item => (item as HTMLInputElement).value));
  await page.keyboard.press("Escape");
  return ids;
}
/** Opens Account & connection, where the privacy and file notes now live. */
export async function openAccount(page: Page) {
  await page.getByRole("button", { name: /Account & connection/ }).first().click();
  return page.getByRole("dialog", { name: "Account & connection" });
}
