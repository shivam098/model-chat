let cached: boolean | undefined;

/**
 * True when the browser draws without a hardware GPU (for example a virtual machine or Remote Desktop session using SwiftShader or WARP).
 * There every animated frame costs real CPU, so the decorative effects slow down. Marks <html data-render="software|gpu"> for CSS.
 */
export function softwareRendering() {
  if (cached !== undefined) return cached;
  try {
    const canvas = document.createElement("canvas");
    // A context that refuses "major performance caveats" isn't created on software renderers.
    const fast = canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null;
    const info = fast?.getExtension("WEBGL_debug_renderer_info");
    const renderer = fast && info ? String(fast.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    fast?.getExtension("WEBGL_lose_context")?.loseContext();
    cached = !fast || /swiftshader|basic render|\bwarp\b|llvmpipe|softpipe|software/i.test(renderer);
  } catch { cached = true; }
  document.documentElement.dataset.render = cached ? "software" : "gpu";
  return cached;
}
