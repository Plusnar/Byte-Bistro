import type { Connect } from 'vite';
export const WEDDING_MODEL: string;
export const WEDDING_PROMPT: string;
export function parseLines(content: string): string[];
export function weddingApi(apiKey: string, fetcher?: typeof fetch): Connect.NextHandleFunction;
