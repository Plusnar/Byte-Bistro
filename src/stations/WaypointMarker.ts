import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Scene,
} from "@babylonjs/core";

export interface WaypointMarkerOptions {
  readonly label: string;
  readonly color: string;
  readonly playerIndex: 0 | 1;
  /**
   * Whether to draw the column and the beam above the ring. A marker that says "go here"
   * wants them; one that says "it lands here" does not, and leaving them out is two fewer
   * meshes to draw.
   */
  readonly beam?: boolean;
}

const MARKER_RING_TUBULAR = 0.08;
const MARKER_RING_RADIUS = 0.85;

const colorFor = (hex: string): Color3 => Color3.FromHexString(hex);

/**
 * Floating waypoint rendered above the next station a player should visit.
 * Includes a glowing column, a slow-orbiting ring, and a downward beam.
 */
export class WaypointMarker {
  readonly root: TransformNode;

  private readonly column: Mesh | null;
  private readonly beam: Mesh | null;
  private readonly ring: Mesh;
  private readonly baseDisc: Mesh;
  private readonly columnMaterial: StandardMaterial;
  private readonly ringMaterial: StandardMaterial;
  private readonly beamMaterial: StandardMaterial;
  private readonly baseMaterial: StandardMaterial;
  private readonly ringBaseEmissive: Color3;
  private scene: Scene;
  private clock = 0;
  private disposed = false;
  private observer: { remove: () => void } | null = null;

  constructor(scene: Scene, options: WaypointMarkerOptions) {
    this.scene = scene;
    this.root = new TransformNode(`waypoint-${options.playerIndex}-${options.label}`, scene);

    const baseColor = colorFor(options.color);

    this.columnMaterial = this.createMaterial(
      `waypoint-column-material-${options.playerIndex}`,
      baseColor,
      0.85,
    );
    this.ringMaterial = this.createMaterial(
      `waypoint-ring-material-${options.playerIndex}`,
      baseColor,
      0.95,
    );
    this.ringBaseEmissive = this.ringMaterial.emissiveColor.clone();
    this.beamMaterial = this.createMaterial(
      `waypoint-beam-material-${options.playerIndex}`,
      baseColor,
      0.6,
    );
    this.baseMaterial = this.createMaterial(
      `waypoint-base-material-${options.playerIndex}`,
      baseColor,
      0.45,
    );

    const withBeam = options.beam ?? true;

    this.column = withBeam
      ? MeshBuilder.CreateCylinder(
        `waypoint-column-${options.playerIndex}`,
        { height: 0.7, diameter: 0.18, tessellation: 16 },
        scene,
      )
      : null;
    if (this.column) {
      this.column.parent = this.root;
      this.column.position.y = 1.3;
      this.column.material = this.columnMaterial;
      this.column.isPickable = false;
    }

    this.ring = MeshBuilder.CreateTorus(
      `waypoint-ring-${options.playerIndex}`,
      { diameter: MARKER_RING_RADIUS * 2, thickness: MARKER_RING_TUBULAR, tessellation: 32 },
      scene,
    );
    this.ring.parent = this.root;
    this.ring.position.y = 0.08;
    this.ring.material = this.ringMaterial;
    this.ring.isPickable = false;

    this.baseDisc = MeshBuilder.CreateDisc(
      `waypoint-base-${options.playerIndex}`,
      { radius: 0.6, tessellation: 32 },
      scene,
    );
    this.baseDisc.rotation.x = Math.PI / 2;
    this.baseDisc.position.y = 0.02;
    this.baseDisc.parent = this.root;
    this.baseDisc.material = this.baseMaterial;
    this.baseDisc.isPickable = false;

    this.beam = withBeam
      ? MeshBuilder.CreateCylinder(
        `waypoint-beam-${options.playerIndex}`,
        { height: 4, diameter: 0.05, tessellation: 12 },
        scene,
      )
      : null;
    if (this.beam) {
      this.beam.parent = this.root;
      this.beam.position.y = 2.0;
      this.beam.material = this.beamMaterial;
      this.beam.isPickable = false;
    }

    const observer = scene.onBeforeRenderObservable.add(this.tick);
    this.observer = {
      remove: () => scene.onBeforeRenderObservable.remove(observer),
    };
  }

  setPosition(position: Vector3): void {
    this.root.position.copyFrom(position);
  }

  setVisible(visible: boolean): void {
    this.root.setEnabled(visible);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.remove();
    this.columnMaterial.dispose();
    this.ringMaterial.dispose();
    this.beamMaterial.dispose();
    this.baseMaterial.dispose();
    this.column?.dispose();
    this.ring.dispose();
    this.beam?.dispose();
    this.baseDisc.dispose();
    this.root.dispose(false, false);
  }

  private tick = (): void => {
    // A hidden marker animates nothing: the aiming markers spend almost the whole shift
    // switched off, and their idle cost should be the observer call and nothing else.
    if (this.disposed || !this.root.isEnabled()) return;
    this.clock += this.scene.getEngine().getDeltaTime() / 1000;
    this.ring.rotation.y = this.clock * 1.6;
    if (this.column) this.column.position.y = 1.3 + Math.sin(this.clock * 4.2) * 0.07;
    if (this.beam) this.beam.scaling.x = this.beam.scaling.z = 1 + Math.sin(this.clock * 5) * 0.18;
    // Scale from the stored base color; scaling the live color compounds every frame.
    const pulse = 0.7 + Math.abs(Math.sin(this.clock * 3.2)) * 0.5;
    this.ringBaseEmissive.scaleToRef(pulse, this.ringMaterial.emissiveColor);
  };

  private createMaterial(name: string, color: Color3, intensity: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = color.scale(0.6);
    material.emissiveColor = color.scale(intensity);
    material.specularColor = new Color3(0, 0, 0);
    material.alpha = 0.95;
    return material;
  }
}
