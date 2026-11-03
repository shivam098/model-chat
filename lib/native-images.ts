import type { ModelInfo } from "@github/copilot-sdk";
import type { FileRecord } from "./store";
import type { NativeImage } from "./contracts";
import { AppError } from "./errors";

export function nativeImages(files: FileRecord[], model: ModelInfo): NativeImage[] {
  if (!files.length) return [];
  const limits = model.capabilities.limits.vision;
  if (!model.capabilities.supports.vision || !limits) throw new AppError(400, "This chat contains images. Select a model marked 'vision'; images will not be silently omitted.");
  if (files.length > limits.max_prompt_images) throw new AppError(400, `This model accepts at most ${limits.max_prompt_images} images per request. Split image analysis into separate requests.`);
  return files.map(file => {
    if (!file.mimeType || !limits.supported_media_types.includes(file.mimeType)) throw new AppError(400, "This model does not accept one of the saved image formats. Choose a compatible vision model.");
    if (file.bytes.length > limits.max_prompt_image_size) throw new AppError(400, "A saved image exceeds this model's image-size limit. Choose another model or upload a smaller image in a new chat.");
    return { type: "blob", mimeType: file.mimeType, data: file.bytes.toString("base64"), displayName: file.name };
  });
}
