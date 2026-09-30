/**
 * What the editor shows for an asset pack. The catalogue keeps the vendors' pack names as
 * data (they are part of every asset id); the screen shows only what the kit is.
 */
const PACK_LABELS: Readonly<Record<string, string>> = {
  "KayKit BlockBits": "Blocos",
  "KayKit Forest Nature Pack": "Floresta e natureza",
  "KayKit Furniture Bits": "Móveis",
  "KayKit Platformer Pack": "Plataformas",
  "KayKit Prototype Bits": "Protótipos",
  "KayKit Restaurant Bits": "Restaurante",
  "KayKit Space Base Bits": "Base espacial",
  "Kenney Cube Pets": "Bichinhos",
  "Kenney Factory Kit": "Fábrica",
  "Kenney Food Kit": "Comidas",
  "Kenney Mini Market": "Minimercado",
  "Kenney Modular Space Kit": "Espaço modular",
  "Kenney Tower Defense Kit": "Defesa de torres",
};

const VENDOR = /^(KayKit|Kenney)\s+/;
const SUFFIX = /\s+(Bits|Pack|Kit)$/;

/** A KayKit or Kenney pack added later still loses the vendor and the "Bits"/"Pack"/"Kit" suffix. */
export const packLabel = (pack: string): string =>
  PACK_LABELS[pack] ?? (VENDOR.test(pack) ? pack.replace(VENDOR, "").replace(SUFFIX, "") : pack);
