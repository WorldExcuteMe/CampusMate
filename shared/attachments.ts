// One contract for the composer and task API; never silently discard images.
export const MAX_IMAGES_PER_MESSAGE = 4;
export const IMAGE_LIMIT_HINT = `每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`;
export function imageLimitError(count: number): string | undefined {
  return count > MAX_IMAGES_PER_MESSAGE
    ? `${IMAGE_LIMIT_HINT}，当前共 ${count} 张。请移除多余图片或分批发送；不会自动截断。`
    : undefined;
}
