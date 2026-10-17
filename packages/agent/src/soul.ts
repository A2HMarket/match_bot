import { readFileSync } from 'node:fs';
import { z } from 'zod';

// src/ and dist/ have the same package-root parent; the deployed workspace includes SOUL.md.
// Fail startup on a missing/invalid persona rather than silently testing an unused prompt.
export const SOUL_INSTRUCTIONS = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .parse(readFileSync(new URL('../SOUL.md', import.meta.url), 'utf8'));
