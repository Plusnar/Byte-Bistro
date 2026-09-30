/**
 * Resolves a path under `public/` against the deploy base.
 *
 * Hardcoding "/images/..." breaks as soon as the game is hosted under a sub-path; every
 * runtime asset lookup should go through here. `src/data/kitchen.ts` already does the same
 * for the 3D asset ids.
 */
export const publicUrl = (relative: string): string =>
  `${import.meta.env.BASE_URL}${relative.replace(/^\/+/, "")}`;
