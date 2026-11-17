import { imageLimitError } from '../../../../shared/attachments';

const MB = 1024 * 1024;
export const ATTACHMENT_LIMITS = {
  count: 8, fileBytes: 5 * MB, totalBytes: 10 * MB, imageBytes: 4 * MB,
  textChars: 100_000, totalTextChars: 200_000, pdfPages: 50,
  zipEntries: 512, zipBytes: 20 * MB, parseMs: 20_000, concurrency: 2,
  requestBytes: 7 * MB, // Margin below the API's 8MB body ceiling.
} as const;
export const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.avif,.pdf,.docx,.txt,.md';
export const ATTACHMENT_LIMIT_HINT = '最多8个附件 · 单文件5MB';
export const ATTACHMENT_LIMIT_DETAILS = '支持 PNG/JPEG/WebP/GIF/AVIF、PDF、DOCX、UTF-8 TXT/MD；每条最多8个附件、合计10MB；图片最多4张且合计4MB；PDF最多50页；文档单份10万字符、合计20万字符。超限整份拒绝，不截断；解析超时20秒会停止。';
export class AttachmentPolicyError extends Error {}
export type FileFormat = 'image' | 'pdf' | 'docx' | 'text';
const formats: Record<string, { format: FileFormat; mimes: string[] }> = {
  png: { format: 'image', mimes: ['image/png'] }, jpg: { format: 'image', mimes: ['image/jpeg'] }, jpeg: { format: 'image', mimes: ['image/jpeg'] },
  webp: { format: 'image', mimes: ['image/webp'] }, gif: { format: 'image', mimes: ['image/gif'] }, avif: { format: 'image', mimes: ['image/avif'] },
  pdf: { format: 'pdf', mimes: ['application/pdf'] }, docx: { format: 'docx', mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  txt: { format: 'text', mimes: ['text/plain'] }, md: { format: 'text', mimes: ['text/plain', 'text/markdown', 'text/x-markdown'] },
};
export function validateAttachmentFile(file: Pick<File, 'name' | 'type' | 'size'>): FileFormat {
  const mime = file.type.toLowerCase().split(';')[0].trim();
  const extension = file.name.includes('.') ? file.name.split('.').at(-1)!.toLowerCase() : undefined;
  const info = extension ? (Object.hasOwn(formats, extension) ? formats[extension] : undefined) : Object.values(formats).find(f => f.mimes.includes(mime));
  if (!info) throw new AttachmentPolicyError(`不支持附件「${file.name}」的文件类型，请使用图片、PDF、DOCX、TXT或MD。`);
  if (mime && mime !== 'application/octet-stream' && !info.mimes.includes(mime)) throw new AttachmentPolicyError(`附件「${file.name}」的类型与扩展名不一致，请确认文件格式。`);
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new AttachmentPolicyError(`附件「${file.name}」为空，未添加。`);
  if (file.size > ATTACHMENT_LIMITS.fileBytes) throw new AttachmentPolicyError(`附件「${file.name}」超过单文件5MB上限，请拆分后添加。`);
  return info.format;
}
export function attachmentImageMime(file: Pick<File, 'name' | 'type'>): string {
  const extension = file.name.split('.').at(-1)!.toLowerCase();
  return (Object.hasOwn(formats, extension) ? formats[extension]?.mimes[0] : undefined) ?? file.type.toLowerCase();
}
export interface BoundedAttachment {
  name: string; kind: 'image' | 'doc'; sizeBytes?: number; file?: Pick<File, 'size'>;
  text?: string; dataUrl?: string;
}
function inlineImageBytes(value = ''): number {
  const comma = value.indexOf(',');
  if (comma >= 0 && value.slice(0, comma).endsWith(';base64')) return Math.max(0, Math.floor((value.length - comma - 1) * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  return new TextEncoder().encode(value).byteLength;
}
export function attachmentSetError(attachments: BoundedAttachment[]): string | undefined {
  const images = attachments.filter(a => a.kind === 'image');
  const imageError = imageLimitError(images.length); if (imageError) return imageError;
  if (attachments.length > ATTACHMENT_LIMITS.count) return '每条消息最多8个附件，请移除多余附件或分批发送；本次选择未添加。';
  let bytes = 0, imageBytes = 0, chars = 0;
  for (const a of attachments) {
    if ((a.text?.length ?? 0) > ATTACHMENT_LIMITS.textChars) return `附件「${a.name}」超过10万字符，请拆分后添加；不会截断内容。`;
    chars += a.text?.length ?? 0;
    if (chars > ATTACHMENT_LIMITS.totalTextChars) return '附件文本合计超过20万字符，请移除部分文档或分批发送；不会截断内容。';
    const inlineBytes = a.kind === 'image' ? inlineImageBytes(a.dataUrl) : 0;
    const size = a.file?.size ?? a.sizeBytes ?? (a.kind === 'image' ? inlineBytes : new TextEncoder().encode(a.text ?? '').byteLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > ATTACHMENT_LIMITS.fileBytes) return `附件「${a.name}」超过单文件5MB上限或大小无效，请移除后重新添加。`;
    bytes += size; if (a.kind === 'image') imageBytes += Math.max(size, inlineBytes);
    if ((a.dataUrl?.length ?? 0) > Math.ceil(ATTACHMENT_LIMITS.imageBytes * 4 / 3) + 128) return '图片内容过大，每条图片合计不超过4MB，请压缩或分批发送。';
  }
  if (bytes > ATTACHMENT_LIMITS.totalBytes) return '附件合计超过10MB，请移除部分附件或分批添加；本次选择未添加。';
  if (imageBytes > ATTACHMENT_LIMITS.imageBytes) return '图片合计超过4MB，请压缩图片或分批发送；本次选择未添加。';
}
export function validateDocumentText(text: string): string {
  if (text.length > ATTACHMENT_LIMITS.textChars) throw new AttachmentPolicyError('文档超过10万字符，请拆分后添加；不会截断内容。');
  if (!text.trim()) throw new AttachmentPolicyError('文档没有可提取的文字；扫描版PDF请先做OCR，空文档不会发送。');
  return text;
}
export function composeAttachmentText(text: string, attachments: BoundedAttachment[]): string {
  const docs = attachments.filter(a => a.kind === 'doc' && a.text).map(a => `\n[附件 ${a.name}]\n${a.text}`).join('');
  const images = attachments.filter(a => a.kind === 'image').map(a => `[图片附件 ${a.name}]`).join(' ');
  return (text.trim() + docs + (images ? '\n' + images : '')).trim();
}
export function attachmentSendError(text: string, attachments: BoundedAttachment[]): string | undefined {
  const error = attachmentSetError(attachments); if (error) return error;
  if (text.length > ATTACHMENT_LIMITS.requestBytes) return '消息过大，请拆分后发送；草稿已保留。';
  const body = JSON.stringify({ intent: composeAttachmentText(text, attachments), images: attachments.filter(a => a.kind === 'image').map(a => a.dataUrl ?? '') });
  if (new TextEncoder().encode(body).byteLength > ATTACHMENT_LIMITS.requestBytes) return '消息和附件编码后超过7MB，请拆分后发送；草稿已保留。';
}
