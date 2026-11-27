import {
  AbstractMesh,
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  Texture,
  TransformNode,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { bundledModelUrl } from "../core/assets/assetRegistry";

/**
 * The world outside the build area: a sky, a lawn to the horizon, a path and clouds.
 *
 * Shared by the map editor and the kitchen (built-in level and custom maps alike), so a map
 * looks the same while it is built and while it is played. Nothing here is pickable or
 * solid, and it lives under its own root: the kitchen's static-decor merge, colliders and
 * glow never see it.
 */

export const BACKDROP_ASSET_ID = "environment-city";
export const BACKDROP_ASSET_URL = bundledModelUrl("src/assets/environment/cidade_sem_arvores.glb");

/** Sky and lawn palette; the horizon doubles as fog and clear colour. */
export const BACKDROP_COLORS = {
  zenith: "#4F8FD1",
  horizon: "#CFE2F0",
  belowHorizon: "#A9C3A2",
  grass: "#6FA24A",
} as const;

export interface SkyPalette {
  readonly zenith: string;
  readonly horizon: string;
  readonly belowHorizon: string;
}

export interface OutdoorBackdropOptions {
  /** Must stay under the camera's maxZ: the dome follows the camera at this radius. */
  readonly skyRadius?: number;
  readonly groundRadius?: number;
  readonly skyPalette?: SkyPalette;
}

export class OutdoorBackdrop {
  /** Everything drawn, for glow exclusion; the path and clouds join once loaded. */
  readonly meshes: AbstractMesh[] = [];
  /** Resolves once the town model loads or fails; the sky and lawn never wait on it. */
  readonly ready: Promise<void>;

  private readonly root: TransformNode;
  private readonly materials: (StandardMaterial | DynamicTexture)[] = [];
  private city: ModelInstance | null = null;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    assets: AssetManager,
    options: OutdoorBackdropOptions = {},
  ) {
    this.root = new TransformNode("outdoor-backdrop", scene);
    const skyPalette = options.skyPalette ?? BACKDROP_COLORS;
    const horizon = Color3.FromHexString(skyPalette.horizon);
    scene.clearColor = Color4.FromColor3(horizon, 1);
    scene.fogColor = horizon.clone();

    this.createSky(options.skyRadius ?? 180, skyPalette);
    this.createGround(options.groundRadius ?? 140);

    if (!assets.has(BACKDROP_ASSET_ID)) {
      assets.registerModel({
        id: BACKDROP_ASSET_ID,
        url: BACKDROP_ASSET_URL,
        required: false,
        lazy: true,
        // Scenery must never hold up a shift or the editor: it arrives when it arrives.
        priority: "background",
      });
    }
    this.ready = this.loadCity(assets).catch((error: unknown) => {
      console.warn("Cenário de fundo indisponível.", error);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.city?.dispose();
    this.city = null;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.root.dispose(false, false);
    this.meshes.length = 0;
  }

  /** A dome that follows the camera, painted with a vertex-colour gradient: no texture. */
  private createSky(radius: number, palette: SkyPalette): void {
    const sky = MeshBuilder.CreateSphere("backdrop-sky", {
      diameter: radius * 2,
      segments: 24,
      sideOrientation: Mesh.BACKSIDE,
    }, this.scene);
    const zenith = Color3.FromHexString(palette.zenith);
    const horizon = Color3.FromHexString(palette.horizon);
    const below = Color3.FromHexString(palette.belowHorizon);
    const positions = sky.getVerticesData(VertexBuffer.PositionKind) ?? [];
    const colors: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const height = (positions[i + 1] ?? 0) / radius;
      const color = height >= 0
        ? Color3.Lerp(horizon, zenith, Math.pow(Math.min(1, height), 0.55))
        : Color3.Lerp(horizon, below, Math.min(1, -height * 6));
      colors.push(color.r, color.g, color.b, 1);
    }
    sky.setVerticesData(VertexBuffer.ColorKind, colors);

    const material = new StandardMaterial("backdrop-sky-material", this.scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.White();
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.backFaceCulling = false;
    material.fogEnabled = false;
    material.freeze();
    this.materials.push(material);

    sky.material = material;
    sky.infiniteDistance = true;
    sky.applyFog = false;
    // Always drawn: its bounds sit at the camera, and culling it only costs a test.
    sky.alwaysSelectAsActiveMesh = true;
    this.adopt(sky, false);
  }

  /** A lawn to the horizon, a hair below the floor tiles so it never fights them. */
  private createGround(radius: number): void {
    const ground = MeshBuilder.CreateDisc("backdrop-ground", { radius, tessellation: 72 }, this.scene);
    ground.rotation.x = Math.PI / 2;
    ground.position.y = -0.03;

    const material = new StandardMaterial("backdrop-ground-material", this.scene);
    material.diffuseColor = Color3.FromHexString(BACKDROP_COLORS.grass);
    material.specularColor = Color3.Black();
    const texture = this.createGrassTexture();
    if (texture) {
      // Tiles of ~4 m: fine enough to read as grass, coarse enough not to shimmer.
      texture.uScale = (radius * 2) / 4;
      texture.vScale = (radius * 2) / 4;
      material.diffuseTexture = texture;
      material.diffuseColor = Color3.White();
    }
    material.freeze();
    this.materials.push(material);
    ground.material = material;
    this.adopt(ground);
  }

  /** Procedural grass: speckles of three greens. Skipped where there is no canvas (tests). */
  private createGrassTexture(): DynamicTexture | null {
    if (typeof document === "undefined") return null;
    const size = 256;
    const texture = new DynamicTexture("backdrop-grass", { width: size, height: size }, this.scene, true);
    const context = texture.getContext();
    context.fillStyle = BACKDROP_COLORS.grass;
    context.fillRect(0, 0, size, size);
    const shades = ["#5E8F3D", "#7DB257", "#86BA5E", "#557F37"];
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 2600; i += 1) {
      context.fillStyle = shades[Math.floor(random() * shades.length)] ?? BACKDROP_COLORS.grass;
      const x = random() * size;
      const y = random() * size;
      // Short blades rather than dots, so the lawn has a grain up close.
      context.fillRect(x, y, 1 + random() * 1.5, 2 + random() * 3);
    }
    texture.update(false);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 8;
    this.materials.push(texture);
    return texture;
  }

  private async loadCity(assets: AssetManager): Promise<void> {
    const instance = await assets.instantiateModel(BACKDROP_ASSET_ID, {
      namePrefix: "backdrop-",
      parent: this.root,
      cloneMaterials: false,
    });
    if (!instance) return;
    if (this.disposed) {
      instance.dispose();
      return;
    }
    this.city = instance;
    // Blender exports PBR, which renders dark without an environment map; the scenery is
    // flat-coloured, so a plain lit material shows it as painted (see LevelMapView).
    const converted = new Map<number, StandardMaterial>();
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh) || node.getTotalVertices() === 0) continue;
        const source = node.material;
        if (source instanceof PBRMaterial) {
          let material = converted.get(source.uniqueId);
          if (!material) {
            material = new StandardMaterial(`backdrop-${source.name}`, this.scene);
            material.diffuseColor.copyFrom(source.albedoColor);
            material.specularColor = Color3.Black();
            // A little self-light keeps the far side of the ring from going flat grey.
            material.emissiveColor = source.albedoColor.scale(0.22);
            material.freeze();
            converted.set(source.uniqueId, material);
            this.materials.push(material);
          }
          node.material = material;
        }
        this.adopt(node);
      }
    }
  }

  /** Unpickable, non-solid scenery; frozen unless it has to follow the camera (the sky). */
  private adopt(mesh: AbstractMesh, frozen = true): void {
    if (!mesh.parent) mesh.parent = this.root;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    if (frozen) {
      mesh.computeWorldMatrix(true);
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;
    }
    this.meshes.push(mesh);
  }
}
