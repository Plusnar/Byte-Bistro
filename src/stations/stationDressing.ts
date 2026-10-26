import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  type Mesh,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { COUNTER_HEIGHT, STARTING_CLEAN_PLATES, type KitchenModelName } from "../data/kitchen";
import type { KitchenStationKind } from "../types/game";

/**
 * What sits on a station, in the station's own frame: the board and knife of a cutting
 * board, the plate stacks, the extinguisher on its stand. The game builds these (see
 * WorkstationView); the editor shows the same, so a station reads as what it is before
 * the shift starts rather than as one more bare counter.
 */
export interface DressingModel {
  readonly model: KitchenModelName;
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

/** How far up a plate sits on the one below it, and how big a stacked plate is. */
export const PLATE_STEP = 0.055;
export const STACKED_PLATE_SCALE = 0.58;
/** The board on a cutting board, and the knife laid beside it. */
export const BOARD: DressingModel = { model: "cuttingboard", position: [0, COUNTER_HEIGHT, 0], scale: [0.55, 0.6, 0.55] };
export const KNIFE_SPOT = { position: [0.36, COUNTER_HEIGHT + 0.1, -0.15], rotationX: Math.PI / 2, scale: 0.5 } as const;
/** Plates the editor shows on a dirty-plate return; in play it starts empty. */
const SHOWN_DIRTY_PLATES = 2;

const stack = (model: KitchenModelName, count: number): DressingModel[] =>
  Array.from({ length: count }, (_, index) => ({
    model,
    position: [0, COUNTER_HEIGHT + index * PLATE_STEP, 0] as const,
    scale: [STACKED_PLATE_SCALE, STACKED_PLATE_SCALE, STACKED_PLATE_SCALE] as const,
  }));

/** The models on a station as the editor shows it; the extinguisher is drawn apart (see buildExtinguisher). */
export const stationDressing = (kind: KitchenStationKind | string | undefined): readonly DressingModel[] => {
  switch (kind) {
    case "cutting_board":
      return [BOARD, {
        model: "knife",
        position: KNIFE_SPOT.position,
        rotation: [KNIFE_SPOT.rotationX, 0, 0],
        scale: [KNIFE_SPOT.scale, KNIFE_SPOT.scale, KNIFE_SPOT.scale],
      }];
    case "plate_rack":
      return stack("plate", STARTING_CLEAN_PLATES);
    case "dirty_return":
      return stack("plate_dirty", SHOWN_DIRTY_PLATES);
    default:
      return [];
  }
};

/** Whether the station holds an extinguisher, drawn with buildExtinguisher. */
export const showsExtinguisher = (kind: KitchenStationKind | string | undefined): boolean => kind === "extinguisher_stand";

/**
 * A red extinguisher standing at `parent`'s origin: the same shape the game draws for
 * the item. Its materials are its own and go with the meshes.
 */
export const buildExtinguisher = (scene: Scene, parent: TransformNode, name: string): Mesh[] => {
  const material = (suffix: string, diffuse: string, emissive: string): StandardMaterial => {
    const made = new StandardMaterial(`${name}-${suffix}`, scene);
    made.diffuseColor = Color3.FromHexString(diffuse);
    made.emissiveColor = Color3.FromHexString(emissive);
    made.specularColor = new Color3(0.15, 0.15, 0.15);
    return made;
  };
  const red = material("body", "#D7263D", "#4A0A12");
  const dark = material("trim", "#1B1F24", "#000000");
  const body = MeshBuilder.CreateCylinder(`${name}-body`, { height: 0.5, diameter: 0.2, tessellation: 12 }, scene);
  body.position.y = 0.25;
  body.material = red;
  const cap = MeshBuilder.CreateCylinder(`${name}-cap`, { height: 0.08, diameter: 0.12, tessellation: 10 }, scene);
  cap.position.y = 0.54;
  cap.material = dark;
  const nozzle = MeshBuilder.CreateBox(`${name}-nozzle`, { width: 0.05, height: 0.05, depth: 0.2 }, scene);
  nozzle.position.set(0, 0.56, 0.1);
  nozzle.material = dark;
  const meshes = [body, cap, nozzle];
  for (const mesh of meshes) mesh.parent = parent;
  body.onDisposeObservable.addOnce(() => {
    red.dispose();
    dark.dispose();
  });
  return meshes;
};
