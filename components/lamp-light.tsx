"use client";

import { useEffect, useRef } from "react";
import { softwareRendering } from "@/lib/render-tier";

type Mote = { x: number; y: number; r: number; vx: number; vy: number; phase: number; speed: number };
type Box = { left: number; top: number; right: number; bottom: number };

/**
 * A soft green lamp light that follows the pointer, with faint dust drifting through it.
 * Decorative only: hidden from assistive technology and painted behind the content of its parent.
 * One stationary canvas draws both the light and the dust, so moving the light never re-lays out or repaints the page above it.
 * Still (drawn once) for reduced motion, small or touch screens and low-power devices; paused while the tab is hidden.
 * `quiet` selects elements whose area stays free of dust so text there is never crossed by moving specks.
 */
export function LampLight({ restX = 0.5, restY = 0.3, quiet }: { restX?: number; restY?: number; quiet?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current;
    const scope = root?.parentElement;
    const canvas = root?.querySelector("canvas");
    const context = canvas?.getContext("2d");
    if (!root || !scope || !canvas || !context) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const compact = matchMedia("(max-width: 760px), (pointer: coarse)");
    const device = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const lowPower = (device.hardwareConcurrency || 8) <= 2 || (device.deviceMemory || 8) <= 2 || Boolean(device.connection?.saveData);
    // Without a GPU every frame costs CPU: draw at half resolution and less often, and let the scene settle 8 seconds after the pointer stops.
    const software = softwareRendering();
    const idleFrame = software ? 120 : 31, activeFrame = software ? 48 : 15, settleAfter = software ? 8000 : Infinity;
    const light = { x: 0, y: 0, tx: 0, ty: 0 };
    const sprite = document.createElement("canvas");
    let width = 0, height = 0, scale = 1, size = 0, reach = 0, animated = false, frame = 0, painted = 0, quietAt = 0, movedAt = -1e9, wokeAt = 0;
    let motes: Mote[] = [];
    let quietBoxes: Box[] = [];
    let dust = "205,234,210";

    const mote = (anywhere: boolean): Mote => ({
      x: Math.random() * width, y: anywhere ? Math.random() * height : height + 4, r: 0.5 + Math.random() * 1.3,
      vx: (Math.random() - 0.5) * 6, vy: -(3 + Math.random() * 8), phase: Math.random() * Math.PI * 2, speed: 0.3 + Math.random() * 0.7,
    });
    // The light itself is painted once into a sprite (a soft radial falloff in the theme's lamp colour) and stamped each frame.
    const paintSprite = () => {
      const style = getComputedStyle(root);
      const lamp = style.getPropertyValue("--lamp").trim() || "120,190,135";
      const strong = Number(style.getPropertyValue("--lamp-a")) || 0.15, soft = Number(style.getPropertyValue("--lamp-a2")) || 0.055;
      dust = style.getPropertyValue("--dust").trim() || dust;
      size = compact.matches ? 560 : 820;
      reach = size * 0.42;
      const pixels = Math.max(1, Math.round(size * scale));
      sprite.width = sprite.height = pixels;
      const paint = sprite.getContext("2d")!;
      const half = pixels / 2;
      const gradient = paint.createRadialGradient(half, half, 0, half, half, half);
      for (const [stop, alpha] of [[0, strong], [0.18, strong * 0.7], [0.42, soft], [0.6, soft * 0.5], [0.78, soft * 0.2], [0.92, soft * 0.05], [1, 0]] as const) gradient.addColorStop(stop, `rgba(${lamp},${alpha})`);
      paint.clearRect(0, 0, pixels, pixels);
      paint.fillStyle = gradient;
      paint.fillRect(0, 0, pixels, pixels);
    };
    const measureQuiet = () => {
      if (!quiet) return;
      const base = root.getBoundingClientRect();
      quietBoxes = [...scope.querySelectorAll(quiet)].map(node => {
        const box = node.getBoundingClientRect();
        return { left: box.left - base.left - 12, top: box.top - base.top - 12, right: box.right - base.left + 12, bottom: box.bottom - base.top + 12 };
      });
    };
    const render = (seconds: number, step: number) => {
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      context.globalAlpha = 1;
      context.drawImage(sprite, light.x - size / 2, light.y - size / 2, size, size);
      if (!animated) return;
      context.fillStyle = `rgb(${dust})`;
      for (const item of motes) {
        item.x += (item.vx + Math.sin(item.phase + seconds * item.speed) * 4) * step;
        item.y += item.vy * step;
        if (item.y < -4) Object.assign(item, mote(false));
        if (item.x < -4) item.x = width + 4; else if (item.x > width + 4) item.x = -4;
        const distance = Math.hypot(item.x - light.x, item.y - light.y);
        if (distance >= reach) continue;
        const alpha = (0.04 + 0.6 * (1 - distance / reach) ** 1.6) * (0.65 + 0.35 * Math.sin(item.phase * 3 + seconds * 1.1));
        if (alpha < 0.02 || quietBoxes.some(box => item.x > box.left && item.x < box.right && item.y > box.top && item.y < box.bottom)) continue;
        context.globalAlpha = alpha;
        context.beginPath();
        context.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    const resize = () => {
      width = root.clientWidth; height = root.clientHeight;
      scale = software ? 0.5 : Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      paintSprite();
      if (animated) {
        const count = Math.max(18, Math.min(64, Math.round(width * height / 22_000)));
        motes = Array.from({ length: count }, (_, index) => motes[index] && motes[index].x <= width && motes[index].y <= height ? motes[index] : mote(true));
      }
      if (!animated || performance.now() - movedAt > 2500) { light.tx = width * restX; light.ty = height * restY; }
      if (!animated) { light.x = light.tx; light.y = light.ty; }
      measureQuiet();
      render(performance.now() / 1000, 0);
    };
    const draw = (time: number) => {
      const step = Math.min(0.15, (time - painted) / 1000);
      painted = time;
      const seconds = time / 1000;
      // Without recent pointer movement the lamp sways slowly around its resting place.
      if (time - movedAt > 2500) { light.tx = width * (restX + Math.sin(seconds * 0.21) * 0.1); light.ty = height * (restY + Math.cos(seconds * 0.17) * 0.06); }
      const ease = 1 - Math.pow(0.004, step);
      light.x += (light.tx - light.x) * ease; light.y += (light.ty - light.y) * ease;
      if (time - quietAt > 1000) { measureQuiet(); quietAt = time; }
      render(seconds, step);
    };
    // Idle: about 30 frames a second (8 without a GPU), as the light only sways and the dust drifts slowly. Following the pointer: 60 (20 without a GPU).
    const loop = (time: number) => {
      if (time - Math.max(movedAt, wokeAt) > settleAfter) { frame = 0; return; }
      frame = requestAnimationFrame(loop);
      if (time - painted < (time - movedAt < 1000 ? activeFrame : idleFrame)) return;
      draw(time);
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    const start = () => { if (animated && !frame && !document.hidden) { painted = wokeAt = performance.now(); frame = requestAnimationFrame(loop); } };
    const evaluate = () => {
      stop();
      animated = !reduced.matches && !compact.matches && !lowPower;
      root.dataset.mode = animated ? "live" : "static";
      resize();
      start();
    };
    const pointer = (event: PointerEvent) => {
      if (!animated || event.pointerType === "touch") return;
      const base = root.getBoundingClientRect();
      light.tx = event.clientX - base.left; light.ty = event.clientY - base.top;
      movedAt = performance.now();
      start();
    };
    const leave = () => { movedAt = -1e9; };
    const visibility = () => { if (document.hidden) stop(); else start(); };
    const resizer = new ResizeObserver(resize);
    const theme = new MutationObserver(() => { paintSprite(); render(performance.now() / 1000, 0); });
    evaluate();
    const reveal = requestAnimationFrame(() => { root.dataset.ready = ""; });
    resizer.observe(root);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    reduced.addEventListener("change", evaluate);
    compact.addEventListener("change", evaluate);
    window.addEventListener("pointermove", pointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop(); cancelAnimationFrame(reveal); resizer.disconnect(); theme.disconnect();
      reduced.removeEventListener("change", evaluate);
      compact.removeEventListener("change", evaluate);
      window.removeEventListener("pointermove", pointer);
      document.documentElement.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [restX, restY, quiet]);
  return <div ref={host} className="lamp" aria-hidden="true"><canvas /></div>;
}
