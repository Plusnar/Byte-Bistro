const generated = new Set(["ram_module"]);

export function ingredientIllustration(ingredientId: string): string {
  return generated.has(ingredientId)
    ? `assets/ui/hud/${ingredientId}.webp`
    : `images/ingredients/${ingredientId}.png`;
}
