import path from 'node:path';
import { knowledgeError } from '@noltri/shared';

export function normalizeVaultPathComponent(input: string): string {
  return input.replace(/\u00a0/g, ' ').normalize('NFC');
}

export function normalizeVaultPath(input: string): string {
  if (input.includes('\0')) throw knowledgeError('invalid_request', '文件路径包含无效字符');
  const normalized = normalizeVaultPathComponent(input.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) throw knowledgeError('invalid_request', 'Vault 文件路径必须是相对路径');
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw knowledgeError('invalid_request', 'Vault 路径不能越出根目录');
  if (parts.some((part) => part.trim() === '')) throw knowledgeError('invalid_request', 'Vault 路径包含空白文件名');
  return parts.join('/');
}

export function pathKey(value: string): string {
  return normalizeVaultPathComponent(value).toLocaleLowerCase('en-US');
}

export function basenameWithoutExtension(value: string): string {
  const name = path.posix.basename(value);
  const extension = path.posix.extname(name);
  return extension.length === 0 ? name : name.slice(0, -extension.length);
}

export function extensionOf(value: string): string {
  return path.posix.extname(value).slice(1).toLocaleLowerCase();
}

export function titleOf(value: string): string {
  return basenameWithoutExtension(value);
}

export function isMarkdownPath(value: string): boolean {
  return /\.md$/i.test(value) || /\.markdown$/i.test(value);
}
