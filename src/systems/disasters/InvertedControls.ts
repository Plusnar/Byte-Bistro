import type { Disaster, DisasterHost } from "./types";

/** Left is right and up is down, for both cooks, until it wears off. */
export class InvertedControls implements Disaster {
  readonly kind = "inverted" as const;
  readonly duration = 20;
  private left = 0;

  constructor(private readonly host: DisasterHost) {}

  start(): void {
    this.left = this.duration;
    for (const cook of this.host.cooks) cook.input.invertMovement = true;
    this.host.sfx.play("zap");
    this.host.shake(0.08, 0.4);
  }

  update(dt: number): boolean {
    this.left -= dt;
    return this.left > 0;
  }

  stop(): void {
    for (const cook of this.host.cooks) cook.input.invertMovement = false;
  }
}
