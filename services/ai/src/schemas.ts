import { z } from 'zod';
import { contextScopeSchema } from '@noltri/schema';

export const extractRequestSchema = z.object({
  text: z.string().min(1).max(20_000),
  surroundingContext: z.string().max(20_000).optional(),
  sourceLabel: z.string().min(1).max(400),
  sourceType: z.string().min(1).max(80),
  maxItems: z.number().int().min(1).max(50).optional(),
});

export const classifyCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(400),
  summary: z.string().max(4_000).nullish(),
  path: z.array(z.string().min(1).max(400)).min(1).max(6),
  itemCount: z.number().int().min(0).optional(),
});

export const classifyRequestSchema = z.object({
  itemText: z.string().min(1).max(20_000),
  suggestedTitle: z.string().max(400).optional(),
  candidates: z.array(classifyCandidateSchema).max(200),
  attachThreshold: z.number().min(0).max(1),
  scopeHint: contextScopeSchema.optional(),
});

export const embedRequestSchema = z.object({
  texts: z.array(z.string().min(1).max(20_000)).min(1).max(200),
});

export const chatRequestSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().min(1).max(20_000) }))
    .min(1)
    .max(60),
  systemContext: z.string().max(40_000).optional(),
  scope: contextScopeSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(32_000).optional(),
});
