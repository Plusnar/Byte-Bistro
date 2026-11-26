import { t, type MessageKey } from "../i18n";

/**
 * What the editor shows for an asset pack. The catalogue keeps the vendors' pack names as
 * data (they are part of every asset id); the screen shows only what the kit is, in the
 * player's language.
 */
const PACK_LABELS: Readonly<Record<string, MessageKey>> = {
  "KayKit BlockBits": "editor.packBlockBits",
  "KayKit Forest Nature Pack": "editor.packForest",
  "KayKit Furniture Bits": "editor.packFurniture",
  "KayKit Platformer Pack": "editor.packPlatformer",
  "KayKit Prototype Bits": "editor.packPrototype",
  "KayKit Restaurant Bits": "editor.packRestaurant",
  "KayKit Space Base Bits": "editor.packSpaceBase",
  "Kenney Cube Pets": "editor.packCubePets",
  "Kenney Factory Kit": "editor.packFactory",
  "Kenney Food Kit": "editor.packFood",
  "Kenney Mini Market": "editor.packMiniMarket",
  "Kenney Modular Space Kit": "editor.packModularSpace",
  "Kenney Tower Defense Kit": "editor.packTowerDefense",
  "Personagens e acessórios": "editor.packCharacters",
  Casamento: "editor.packWedding",
  "Igreja Matriz": "editor.packChurch",
  "Praça": "editor.packSquare",
  Schlachtfest: "editor.packSchlachtfest",
  "Salão Pauli": "editor.packPauli",
};

const VENDOR = /^(KayKit|Kenney)\s+/;
const SUFFIX = /\s+(Bits|Pack|Kit)$/;

/** A KayKit or Kenney pack added later still loses the vendor and the "Bits"/"Pack"/"Kit" suffix. */
export const packLabel = (pack: string): string => {
  const key = PACK_LABELS[pack];
  if (key) return t(key);
  return VENDOR.test(pack) ? pack.replace(VENDOR, "").replace(SUFFIX, "") : pack;
};
