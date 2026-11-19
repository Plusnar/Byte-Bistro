const generated = new Set(["ram_module", "ram_dough", "cookie_dough", "gelato_mix"]);

export function ingredientIllustration(ingredientId: string): string {
  return generated.has(ingredientId)
    ? `assets/ui/hud/${ingredientId}.webp`
    : `images/ingredients/${ingredientId}.png`;
}
