import {
  Color3,
  Mesh,
  MeshBuilder,
  PointLight,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { t } from "../../i18n";
import { STOREY_REACH } from "../../physics/collisionPolicy";
import { between, type Disaster, type DisasterHost } from "./types";

/** How long a strike's circle shows on the floor before the bolt comes down. */
export const STRIKE_WARNING_SECONDS = 1.3;
/** Radius of a strike, in metres: inside the circle when it lands, a cook goes down. */
export const STRIKE_RADIUS = 0.95;
const BOLT_SECONDS = 0.22;
const SCORCH_SECONDS = 2.2;
const BOLT_TOP = 16;

interface Strike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  clock: number;
  readonly marker: Mesh;
  readonly ring: Mesh;
  bolt: Mesh | null;
  light: PointLight | null;
  struck: boolean;
}

/**
 * Bolts come down all over the kitchen, near the cooks. Each strike first shows a
 * red circle on the floor with a ring closing in on it, then the bolt lands there
 * with a flash and a thunderclap, knocking down anyone still inside.
 */
export class LightningStorm implements Disaster {
  readonly kind = "lightning" as const;
  readonly duration = 20;
  private clock = 0;
  private nextStrike = 0.4;
  private readonly strikes: Strike[] = [];
  private readonly markerMaterial: StandardMaterial;
  private readonly ringMaterial: StandardMaterial;
  private readonly boltMaterial: StandardMaterial;
  private readonly scorchMaterial: StandardMaterial;

  constructor(private readonly host: DisasterHost, private readonly random: () => number = Math.random) {
    const scene = host.scene;
    this.markerMaterial = this.flat("lightning-marker", "#FF3355", 0.42);
    this.ringMaterial = this.flat("lightning-ring", "#FFE066", 0.95);
    this.boltMaterial = this.flat("lightning-bolt", "#E6F6FF", 1);
    this.scorchMaterial = new StandardMaterial("lightning-scorch", scene);
    this.scorchMaterial.diffuseColor = Color3.FromHexString("#120d10");
    this.scorchMaterial.specularColor = Color3.Black();
    this.scorchMaterial.alpha = 0.7;
  }

  start(): void {
    this.clock = 0;
    this.nextStrike = 0.4;
    this.host.sfx.play("thunder", 0.6);
  }

  update(dt: number): boolean {
    this.clock += dt;
    if (this.clock < this.duration) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.addStrike();
        // A volley thickens as the storm goes on.
        this.nextStrike = between(0.7, 1.3, this.random) * (this.clock > this.duration / 2 ? 0.75 : 1);
      }
    }
    for (const strike of [...this.strikes]) this.updateStrike(strike, dt);
    return this.clock < this.duration || this.strikes.length > 0;
  }

  stop(): void {
    for (const strike of this.strikes) this.disposeStrike(strike);
    this.strikes.length = 0;
    for (const material of [this.markerMaterial, this.ringMaterial, this.boltMaterial, this.scorchMaterial]) {
      material.dispose();
    }
  }

  /** Mostly next to a cook, so standing still is never safe; sometimes anywhere. */
  private addStrike(): void {
    const { bounds, cooks } = this.host;
    const targets = cooks.filter((cook) => !cook.player.isAbducted);
    let referenceY = targets[0]?.player.position.y ?? 0;
    let x: number;
    let z: number;
    if (targets.length > 0 && this.random() < 0.75) {
      const cook = targets[Math.floor(this.random() * targets.length)]!;
      referenceY = cook.player.position.y;
      const angle = this.random() * Math.PI * 2;
      const distance = this.random() * 1.1;
      x = cook.player.position.x + Math.cos(angle) * distance;
      z = cook.player.position.z + Math.sin(angle) * distance;
    } else {
      x = between(bounds.minX, bounds.maxX, this.random);
      z = between(bounds.minZ, bounds.maxZ, this.random);
    }
    x = Math.min(bounds.maxX, Math.max(bounds.minX, x));
    z = Math.min(bounds.maxZ, Math.max(bounds.minZ, z));

    const y = this.host.floorHeight(x, referenceY, z);
    const scene = this.host.scene;
    const marker = MeshBuilder.CreateDisc("lightning-target", { radius: STRIKE_RADIUS, tessellation: 40 }, scene);
    marker.rotation.x = Math.PI / 2;
    marker.position.set(x, y + 0.03, z);
    marker.material = this.markerMaterial;
    marker.isPickable = false;
    const ring = MeshBuilder.CreateTorus("lightning-ring", {
      diameter: STRIKE_RADIUS * 2,
      thickness: 0.07,
      tessellation: 40,
    }, scene);
    ring.position.set(x, y + 0.05, z);
    ring.material = this.ringMaterial;
    ring.isPickable = false;
    this.strikes.push({ x, y, z, clock: 0, marker, ring, bolt: null, light: null, struck: false });
  }

  private updateStrike(strike: Strike, dt: number): void {
    strike.clock += dt;
    if (!strike.struck) {
      const t = Math.min(1, strike.clock / STRIKE_WARNING_SECONDS);
      // The ring closes in and the circle flashes faster as the bolt draws near.
      strike.ring.scaling.setAll(Math.max(0.05, 1.6 - 1.55 * t));
      strike.marker.visibility = 0.55 + 0.45 * Math.abs(Math.sin(strike.clock * (6 + 18 * t)));
      if (t >= 1) this.land(strike);
      return;
    }

    const since = strike.clock - STRIKE_WARNING_SECONDS;
    if (strike.bolt) {
      // A flicker or two, then gone.
      const visible = since < BOLT_SECONDS && Math.floor(since * 40) % 3 !== 1;
      strike.bolt.isVisible = visible;
      for (const twig of strike.bolt.getChildMeshes()) twig.isVisible = visible;
      if (since >= BOLT_SECONDS) {
        strike.bolt.dispose();
        strike.bolt = null;
      }
    }
    if (strike.light) {
      strike.light.intensity = Math.max(0, 14 * (1 - since / 0.35));
      if (since >= 0.35) {
        strike.light.dispose();
        strike.light = null;
      }
    }
    // What is left is a scorch mark, fading.
    strike.marker.visibility = Math.max(0, 1 - since / SCORCH_SECONDS);
    if (since >= SCORCH_SECONDS) {
      this.disposeStrike(strike);
      this.strikes.splice(this.strikes.indexOf(strike), 1);
    }
  }

  private land(strike: Strike): void {
    strike.struck = true;
    strike.ring.dispose();
    strike.marker.material = this.scorchMaterial;
    strike.marker.scaling.setAll(0.75);
    const scene = this.host.scene;

    strike.bolt = this.makeBolt(strike.x, strike.y, strike.z);
    const light = new PointLight("lightning-flash", new Vector3(strike.x, strike.y + 3, strike.z), scene);
    light.diffuse = Color3.FromHexString("#CFEAFF");
    light.intensity = 14;
    light.range = 9;
    strike.light = light;

    this.host.overlay.flash(0.7);
    this.host.sfx.play("thunder");
    this.host.shake(0.22, 0.45);

    for (const cook of this.host.cooks) {
      const player = cook.player;
      if (player.isDowned() || Math.abs(player.position.y - strike.y) > STOREY_REACH) continue;
      const dx = player.position.x - strike.x;
      const dz = player.position.z - strike.z;
      if (dx * dx + dz * dz > STRIKE_RADIUS * STRIKE_RADIUS) continue;
      this.host.hitCook(cook, strike.x, strike.z, 0.8);
      player.setExpression("X_X");
      this.host.notify(t("disaster.struck", { name: cook.label }), "error");
    }
  }

  /** A jagged bolt from the sky to (x, z), with a couple of short branches. */
  private makeBolt(x: number, floor: number, z: number): Mesh {
    const scene = this.host.scene;
    const path: Vector3[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i += 1) {
      const y = floor + BOLT_TOP * (1 - i / steps);
      const jitter = i === 0 || i === steps ? 0 : 0.55;
      path.push(new Vector3(
        x + (this.random() - 0.5) * 2 * jitter,
        y,
        z + (this.random() - 0.5) * 2 * jitter,
      ));
    }
    const bolt = MeshBuilder.CreateTube("lightning-bolt", { path, radius: 0.09, tessellation: 6 }, scene);
    for (const start of [4, 8]) {
      const from = path[start]!;
      const branch = [from, from.add(new Vector3((this.random() - 0.5) * 2.4, -1.6, (this.random() - 0.5) * 2.4))];
      const twig = MeshBuilder.CreateTube("lightning-branch", { path: branch, radius: 0.04, tessellation: 5 }, scene);
      twig.parent = bolt;
      twig.material = this.boltMaterial;
      twig.isPickable = false;
    }
    bolt.material = this.boltMaterial;
    bolt.isPickable = false;
    return bolt;
  }

  private disposeStrike(strike: Strike): void {
    strike.marker.dispose();
    if (!strike.ring.isDisposed()) strike.ring.dispose();
    strike.bolt?.dispose();
    strike.light?.dispose();
  }

  private flat(name: string, hex: string, alpha: number): StandardMaterial {
    const material = new StandardMaterial(name, this.host.scene);
    const colour = Color3.FromHexString(hex);
    material.diffuseColor = colour;
    material.emissiveColor = colour;
    material.disableLighting = true;
    material.alpha = alpha;
    material.backFaceCulling = false;
    return material;
  }
}
