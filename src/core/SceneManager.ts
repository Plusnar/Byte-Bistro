import type { AbstractEngine, Scene } from "@babylonjs/core";

export interface ManagedScene {
  readonly scene: Scene;
  update(deltaSeconds: number): void;
  dispose(): void;
}

export class SceneManager {
  private current: ManagedScene | null = null;

  constructor(private readonly engine: AbstractEngine) {}

  set(scene: ManagedScene): void {
    if (this.current === scene) return;
    this.current?.dispose();
    this.current = scene;
  }

  update(deltaSeconds: number): void {
    this.current?.update(deltaSeconds);
  }

  render(): void {
    this.current?.scene.render();
  }

  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
  }
}
