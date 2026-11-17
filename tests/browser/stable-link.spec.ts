import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

// The shareable-link page, served locally exactly as GitHub Pages serves it; link.json and the tunnel are simulated.
const pageOrigin = "http://127.0.0.1:3216";
const live = "https://good-link.trycloudflare.com";
let server: Server;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    const name = new URL(request.url!, pageOrigin).pathname.replace(/^\/model-chat\//, "") || "index.html";
    if (!["index.html", "forward.js"].includes(name)) return void response.writeHead(404).end();
    response.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : "text/html" }).end(readFileSync(path.resolve("link-page", name)));
  });
  await new Promise<void>(resolve => server.listen(3216, "127.0.0.1", resolve));
});
test.afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

async function publish(page: Page, document: unknown) {
  await page.route("**/model-chat/link.json*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(document) }));
}
function tunnel(page: Page, up: () => boolean, requests: string[] = []) {
  return page.route("https://*.trycloudflare.com/**", route => {
    const url = route.request().url();
    requests.push(url);
    if (!up()) return route.fulfill({ status: 530, contentType: "text/html", body: "Cloudflare error 1033" });
    if (url.includes("/api/link-status")) return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": pageOrigin }, body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Model Chat app</title><input type=email><input type=password>" });
  });
}

test("the shareable link forwards only to a live published Quick Tunnel and otherwise explains why not", async ({ page }) => {
  const requests: string[] = [];
  let up = true;
  await tunnel(page, () => up, requests);
  await publish(page, { online: true, url: live, updatedAt: "2026-11-11T00:00:00Z" });
  await page.goto(`${pageOrigin}/model-chat/`);
  await expect(page).toHaveURL(`${live}/`);
  await expect(page).toHaveTitle("Model Chat app");
  expect(requests.some(url => url.startsWith(`${live}/api/link-status?t=`))).toBe(true);

  // Published but down (tunnel stopped or PC off): no forward to a Cloudflare error, a fallback link, and automatic re-checks.
  await page.unrouteAll();
  up = false;
  await tunnel(page, () => up);
  await publish(page, { online: true, url: live, updatedAt: "2026-11-11T00:00:00Z" });
  await page.clock.install();
  await page.goto(`${pageOrigin}/model-chat/`);
  await expect(page.locator("body")).toHaveAttribute("data-state", "unreachable");
  await expect(page.locator("#message")).toContainText("isn't reachable");
  await expect(page.getByRole("link", { name: "open Model Chat" })).toHaveAttribute("href", `${live}/`);
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/stable-link-unreachable-mobile.png" });
  up = true;
  await page.clock.fastForward(16_000);
  await expect(page).toHaveURL(`${live}/`);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Marked offline by tunnel:stop.
  await page.unrouteAll();
  await tunnel(page, () => true);
  await publish(page, { online: false, url: null, updatedAt: "2026-11-11T00:00:00Z" });
  await page.goto(`${pageOrigin}/model-chat/`);
  await expect(page.locator("body")).toHaveAttribute("data-state", "offline");
  await expect(page.locator("#message")).toContainText("offline");
  await expect(page.locator("#fallback")).toBeHidden();
  await page.screenshot({ path: "test-results/stable-link-offline-desktop.png" });
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await page.unroute("**/model-chat/link.json*");
  await publish(page, { online: true, url: live });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page).toHaveURL(`${live}/`);
});

test("the shareable link never forwards to or probes anything other than an exact HTTPS Quick Tunnel origin", async ({ page }) => {
  const contacted: string[] = [];
  page.on("request", request => { if (!request.url().startsWith(pageOrigin)) contacted.push(request.url()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: '{"ok":true}' }));
  for (const url of [
    "https://evil.test", "http://good-link.trycloudflare.com", "https://api.trycloudflare.com", "https://good-link.trycloudflare.com.evil.test",
    "https://good-link.trycloudflare.com/phish", "javascript:alert(1)", 42,
  ]) {
    await page.unroute("**/model-chat/link.json*");
    await publish(page, { online: true, url });
    await page.goto(`${pageOrigin}/model-chat/`);
    await expect(page.locator("body")).toHaveAttribute("data-state", "offline");
    expect(page.url()).toBe(`${pageOrigin}/model-chat/`);
    await expect(page.locator("#fallback")).toBeHidden();
  }
  expect(contacted).toEqual([]);
  await page.unroute("**/model-chat/link.json*");
  await page.route("**/model-chat/link.json*", route => route.fulfill({ status: 404, body: "" }));
  await page.goto(`${pageOrigin}/model-chat/`);
  await expect(page.locator("body")).toHaveAttribute("data-state", "unavailable");
});
