import { Color3, Constants, Mesh, MeshBuilder, Quaternion, ShaderMaterial, Vector3 } from "@babylonjs/core";
import type { Scene, TransformNode } from "@babylonjs/core";

const shader = {
  vertexSource: `precision highp float;
    attribute vec3 position;
    attribute vec3 normal;
    uniform mat4 worldViewProjection;
    uniform mat4 worldView;
    varying float along;
    varying vec3 viewPosition;
    varying vec3 viewNormal;
    void main() {
      along = 0.5 - position.y;
      viewPosition = (worldView * vec4(position, 1.0)).xyz;
      viewNormal = mat3(worldView) * vec3(normal.x, 0.0, normal.z);
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }`,
  fragmentSource: `precision highp float;
    uniform vec3 tint;
    uniform float energy;
    varying float along;
    varying vec3 viewPosition;
    varying vec3 viewNormal;
    void main() {
      float edge = abs(dot(normalize(viewNormal), normalize(-viewPosition)));
      float haze = smoothstep(0.03, 0.86, edge);
      float fade = smoothstep(0.0, 0.09, along) * (1.0 - smoothstep(0.68, 1.0, along));
      gl_FragColor = vec4(tint, haze * fade * energy);
    }`,
};

const down = new Vector3(0, -1, 0);

/** One depth-tested cone of lit haze. The paired Babylon light illuminates scenery. */
export class PauliBeam {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly rotation = Quaternion.Identity();
  private readonly tint = new Color3();

  constructor(name: string, scene: Scene, parent: TransformNode, energy: number) {
    this.mesh = MeshBuilder.CreateCylinder(name, {
      height: 1, diameterTop: 0, diameterBottom: 2, tessellation: 16, cap: Mesh.NO_CAP,
    }, scene);
    this.mesh.parent = parent;
    this.mesh.isPickable = false;
    this.mesh.rotationQuaternion = this.rotation;
    this.material = new ShaderMaterial(name, scene, shader, {
      attributes: ["position", "normal"],
      uniforms: ["worldViewProjection", "worldView", "tint", "energy"],
      needAlphaBlending: true,
    });
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.disableDepthWrite = true;
    this.material.backFaceCulling = false;
    this.material.setFloat("energy", energy);
    this.material.setColor3("tint", this.tint);
    this.mesh.material = this.material;
  }

  aim(origin: Vector3, direction: Vector3, range: number, spread: number, tint: Color3): void {
    // End above the dance floor. Furniture and walls still mask it through the depth buffer.
    const length = Math.min(range, Math.max(0.2, (origin.y - 0.02) / Math.max(0.08, -direction.y)));
    const radius = length * spread;
    this.mesh.position.copyFrom(origin).addInPlaceFromFloats(
      direction.x * length / 2, direction.y * length / 2, direction.z * length / 2,
    );
    this.mesh.scaling.set(radius, length, radius);
    Quaternion.FromUnitVectorsToRef(down, direction, this.rotation);
    this.tint.copyFrom(tint);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}
