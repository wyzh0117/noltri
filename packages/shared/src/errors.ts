import { z } from 'zod';
import type { ApiErrorCode } from '@noltri/schema';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  provider_error: 502,
  storage_error: 500,
  rate_limited: 429,
  internal_error: 500,
};

export class KnowledgeError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function knowledgeError(code: ApiErrorCode, message: string, details?: unknown) {
  return new KnowledgeError(code, message, details);
}

export function isKnowledgeError(value: unknown): value is KnowledgeError {
  return value instanceof KnowledgeError;
}

export function asKnowledgeError(error: unknown): KnowledgeError {
  if (isKnowledgeError(error)) return error;
  if (error instanceof z.ZodError) {
    return new KnowledgeError('invalid_request', 'Request payload failed validation', error.issues);
  }
  if (error instanceof Error) {
    return new KnowledgeError('internal_error', error.message || 'Unexpected error');
  }
  return new KnowledgeError('internal_error', 'Unexpected error');
}

export function errorResponseBody(error: unknown) {
  return asKnowledgeError(error).toJSON();
}
