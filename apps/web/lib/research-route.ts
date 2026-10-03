/**
 * Shared parsing helpers for the `/api/web/research/*` proxy routes: path-id validation plus body and
 * query parsing against the shared `@noltri/schema` request schemas. Every route rejects locally with
 * the frozen `invalid_request` envelope before anything reaches Knowledge Core.
 */

import { invalidRequestError } from './core';

/** Structural stand-in for a Zod schema so this module needs no direct zod dependency. */
type ParseResult<T> = { success: true; data: T } | { success: false; error: { issues: unknown } };

export interface RequestSchema<T> {
  safeParse(data: unknown): ParseResult<T>;
}

export function parseWithSchema<T>(schema: RequestSchema<T>, data: unknown, message: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw invalidRequestError(message, parsed.error.issues);
  return parsed.data;
}

/** Path segments are validated as non-empty ids; their shape is the core's business. */
export function parseIdParam(value: string | undefined, message: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0) throw invalidRequestError(message);
  return id;
}

/** Read only the query keys a route understands, as the string maps the schema query types expect. */
export function queryOf(request: Request, keys: readonly string[]): Record<string, string | undefined> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string | undefined> = {};
  for (const key of keys) raw[key] = params.get(key) ?? undefined;
  return raw;
}
