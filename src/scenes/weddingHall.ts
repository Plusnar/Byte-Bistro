import { Vector3 } from "@babylonjs/core";
import { ASSET_LIBRARY } from "../data/assetLibrary";
import type { ScenarioPlacement } from "./KitchenEnvironment";

/**
 * The wedding hall around the main level's kitchen, built from the Casamento pack.
 *
 * Layout, looking from the camera (south, -z) toward the back wall (+z):
 *
 *   z  6.9   ── back wall with windows ───────────────────────────────────
 *   z  6.3   balloons · vase · planter · column  [ARCH]  column · planter · vase
 *   z  5.5                                      altar
 *   z  4.4   welcome   round table   ·  guests' aisle  ·  round table   cake
 *   z  3.0   gifts        + chairs      (robots mingle)     + chairs    table
 *   z  2.0   ── pass counters (the kitchen's serving line) ──────────────
 *   z -4.4   ── ingredient crates; the cooks work between here and the pass
 *
 * The robots' reception area (see DEFAULT_KITCHEN_LAYOUT.receptionArea) is the open
 * aisle in the middle; every piece of furniture stays outside it, so the guests never
 * spawn inside a table or pick a spot they cannot reach.
 *
 * All positions are world metres. Rotation 0 faces the camera; the pack's own scale
 * (1.25, see Scenario/Casamento/pack.json) is applied on top of any per-piece scale.
 */

const PACK = "library:Scenario/Casamento/";
const packScale = new Map(ASSET_LIBRARY.map((entry) => [entry.id, entry.scale]));

interface PieceOptions {
  readonly y?: number;
  readonly rotationY?: number;
  /** Multiplies the pack scale, per axis. */
  readonly stretch?: { readonly x?: number; readonly y?: number; readonly z?: number };
}

let pieceSequence = 0;
const piece = (file: string, x: number, z: number, options: PieceOptions = {}): ScenarioPlacement => {
  const assetId = `${PACK}${file}`;
  const base = packScale.get(assetId) ?? { x: 1.25, y: 1.25, z: 1.25 };
  const stretch = options.stretch ?? {};
  return {
    name: `wedding-${file.replace(/\.glb$/, "")}-${pieceSequence++}`,
    assetId,
    position: new Vector3(x, options.y ?? 0, z),
    rotation: new Vector3(0, options.rotationY ?? 0, 0),
    scale: new Vector3(base.x * (stretch.x ?? 1), base.y * (stretch.y ?? 1), base.z * (stretch.z ?? 1)),
  };
};

/** Faces a piece at (x, z) toward a point, for chairs around a table. */
const facing = (x: number, z: number, targetX: number, targetZ: number): number =>
  Math.atan2(-(targetX - x), -(targetZ - z));

const TILE = 1.25;
const HALF_WIDTH = 10;
/** Column centres of the 16 floor tiles across the room. */
const COLUMNS = Array.from({ length: 16 }, (_, index) => -HALF_WIDTH + TILE / 2 + index * TILE);

// Checkered tiles under the kitchen, wood under the reception.
const KITCHEN_ROWS = [-5.875, -4.625, -3.375, -2.125, -0.875, 0.375, 1.625];
const HALL_ROWS = [2.875, 4.125, 5.375, 6.625];

const floors: ScenarioPlacement[] = [
  ...KITCHEN_ROWS.flatMap((z) => COLUMNS.map((x) => piece("piso_xadrez.glb", x, z))),
  ...HALL_ROWS.flatMap((z) => COLUMNS.map((x) => piece("piso_madeira.glb", x, z))),
];

/** The plain wall piece is 1.084 m wide; narrowing it to one tile keeps the joints flush. */
const WALL_STRETCH = { x: 1 / 1.084 };
const BACK_WALL_Z = 6.9;
const SIDE_WALL_X = 10.35;
const BACK_WINDOWS = new Set([1, 2, 4, 5, 10, 11, 13, 14]);

const walls: ScenarioPlacement[] = [
  ...COLUMNS.map((x, index) =>
    BACK_WINDOWS.has(index)
      ? piece("parede_janela.glb", x, BACK_WALL_Z)
      : piece("parede.glb", x, BACK_WALL_Z, { stretch: WALL_STRETCH }),
  ),
  // Side walls, facing into the room; windows along the reception.
  ...[-1, 1].flatMap((side) =>
    [...KITCHEN_ROWS, ...HALL_ROWS].map((z, index) => {
      const window = index === 2 || index === 5 || index === 8;
      return window
        ? piece("parede_janela.glb", side * SIDE_WALL_X, z, { rotationY: side * Math.PI / 2 })
        : piece("parede.glb", side * SIDE_WALL_X, z, { rotationY: side * Math.PI / 2, stretch: WALL_STRETCH });
    }),
  ),
];

/** A round table with its centrepiece and four chairs facing it. */
const roundTable = (x: number, z: number): ScenarioPlacement[] => {
  const TABLE_TOP = 0.94;
  const CHAIR_RADIUS = 1.25;
  return [
    piece("mesa_redonda.glb", x, z),
    piece("centro_mesa.glb", x, z, { y: TABLE_TOP }),
    ...[45, 135, 225, 315].map((degrees) => {
      const angle = (degrees * Math.PI) / 180;
      const chairX = x + Math.cos(angle) * CHAIR_RADIUS;
      const chairZ = z + Math.sin(angle) * CHAIR_RADIUS;
      return piece("cadeira.glb", chairX, chairZ, { rotationY: facing(chairX, chairZ, x, z) });
    }),
  ];
};

const ceremony: ScenarioPlacement[] = [
  piece("arco_flores.glb", 0, 6.3),
  piece("altar.glb", 0, 5.55),
  piece("topiaria_coracao.glb", -2.05, 6.25),
  piece("topiaria_coracao.glb", 2.05, 6.25),
  piece("coluna.glb", -2.95, 6.35),
  piece("coluna.glb", 2.95, 6.35),
  // The aisle runner the guests stand along; low enough to walk over.
  piece("tapete_corredor.glb", 0, 3.35),
  piece("tapete_corredor.glb", 0, 4.6),
  piece("lanterna.glb", -0.95, 2.95),
  piece("lanterna.glb", 0.95, 2.95),
];

const CAKE_TABLE = { x: 8.7, z: 4.7 };
const TABLE_TOP = 0.94;

const receptionSides: ScenarioPlacement[] = [
  ...roundTable(-5.6, 4.4),
  ...roundTable(5.6, 4.4),
  // Left: where the guests come in.
  piece("placa_boas_vindas.glb", -8.8, 3.4, { rotationY: -0.45 }),
  piece("presentes.glb", -8.9, 5.0, { rotationY: -0.3 }),
  piece("baloes_coracao.glb", -8.6, 6.1),
  piece("vaso_pedestal.glb", -7.2, 6.2),
  piece("floreira.glb", -4.4, 6.4),
  // Right: the cake, on a long table running back from the pass.
  piece("mesa_retangular.glb", CAKE_TABLE.x, CAKE_TABLE.z, { rotationY: Math.PI / 2 }),
  piece("bolo_casamento.glb", CAKE_TABLE.x, CAKE_TABLE.z + 0.75, { y: TABLE_TOP }),
  piece("tacas_champanhe.glb", CAKE_TABLE.x - 0.15, CAKE_TABLE.z - 0.35, { y: TABLE_TOP }),
  piece("balde_champanhe.glb", CAKE_TABLE.x + 0.15, CAKE_TABLE.z - 0.75, { y: TABLE_TOP }),
  piece("candelabro.glb", CAKE_TABLE.x, CAKE_TABLE.z - 1.15, { y: TABLE_TOP, rotationY: Math.PI / 2 }),
  piece("buque.glb", CAKE_TABLE.x - 0.1, CAKE_TABLE.z + 0.05, { y: TABLE_TOP }),
  piece("baloes_coracao.glb", 9.3, 3.0, { rotationY: 0.3 }),
  piece("vaso_pedestal.glb", 7.2, 6.2),
  piece("floreira.glb", 4.4, 6.4),
  // Corners, where the side walls meet the back wall.
  piece("coluna.glb", -9.95, 6.55),
  piece("coluna.glb", 9.95, 6.55),
];

export const WEDDING_HALL_PLACEMENTS: readonly ScenarioPlacement[] = [
  ...floors,
  ...walls,
  ...ceremony,
  ...receptionSides,
];

/** Every model the hall uses, for the kitchen's loader. */
export const WEDDING_HALL_ASSET_IDS: readonly string[] = [
  ...new Set(WEDDING_HALL_PLACEMENTS.map((placement) => placement.assetId)),
];

/** Where the couple's name hangs: a banner just above the flower arch. */
export const WEDDING_BANNER = { x: 0, y: 3.75, z: 6.05, width: 2.9, height: 0.56 } as const;
