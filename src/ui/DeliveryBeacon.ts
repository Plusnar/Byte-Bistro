import { t } from "../i18n";
import { publicUrl } from "../utils/assetUrl";

/** One delivery counter to point at, in pixels of the HUD layer. */
export interface BeaconTarget {
  readonly x: number;
  readonly y: number;
  /** False when the point is behind the camera: its direction is flipped, never shown in place. */
  readonly inFront: boolean;
}

/** How far from the HUD's edges an off-screen arrow sits, in pixels. */
const EDGE_MARGIN = 46;

interface Marker {
  readonly root: HTMLElement;
  readonly pin: HTMLElement;
  mode: "pin" | "edge" | "hidden";
  lastTransform: string;
  lastShift: string;
  /** Half the pin's width, measured when it turns into a pin (not every frame). */
  pinHalf: number;
}

/**
 * "Deliver here": marks the delivery counter while a finished dish is waiting to be served.
 *
 * On screen it is a bouncing pin over the counter; off screen it becomes an arrow on the
 * nearest edge, turned toward the counter, so a cook holding a finished plate always knows
 * which way to run. Babylon-free: `KitchenScene` projects the counters and hands over pixels.
 * DOM writes happen only when something changed.
 */
export class DeliveryBeacon {
  private readonly markers: Marker[] = [];

  constructor(private readonly host: HTMLElement) {}

  update(targets: readonly BeaconTarget[], width: number, height: number): void {
    targets.forEach((target, index) => this.place(this.marker(index), target, width, height));
    for (let index = targets.length; index < this.markers.length; index += 1) this.hide(this.markers[index]!);
  }

  hideAll(): void {
    for (const marker of this.markers) this.hide(marker);
  }

  dispose(): void {
    for (const marker of this.markers) marker.root.remove();
    this.markers.length = 0;
  }

  private marker(index: number): Marker {
    const existing = this.markers[index];
    if (existing) return existing;
    const root = document.createElement("div");
    root.className = "delivery-beacon";
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    const pin = document.createElement("div");
    pin.className = "delivery-beacon-pin";
    const label = document.createElement("span");
    label.className = "delivery-beacon-label";
    label.textContent = t("kitchen.deliverHere");
    const icon = document.createElement("img");
    icon.className = "delivery-beacon-icon";
    icon.alt = "";
    icon.src = publicUrl("assets/ui/hud/serve.webp");
    const arrow = document.createElement("span");
    arrow.className = "delivery-beacon-arrow";
    pin.append(icon, label);
    root.append(pin, arrow);
    this.host.append(root);
    const marker: Marker = { root, pin, mode: "hidden", lastTransform: "", lastShift: "", pinHalf: 0 };
    this.markers.push(marker);
    return marker;
  }

  private place(marker: Marker, target: BeaconTarget, width: number, height: number): void {
    const inside = target.inFront &&
      target.x >= EDGE_MARGIN && target.x <= width - EDGE_MARGIN &&
      target.y >= EDGE_MARGIN && target.y <= height - EDGE_MARGIN;
    let x = target.x;
    let y = target.y;
    let angle = 90;
    if (!inside) {
      const cx = width / 2;
      const cy = height / 2;
      let dx = target.x - cx;
      let dy = target.y - cy;
      if (!target.inFront) {
        dx = -dx;
        dy = -dy;
      }
      if (dx === 0 && dy === 0) dy = 1;
      const scale = Math.min(
        dx === 0 ? Infinity : (cx - EDGE_MARGIN) / Math.abs(dx),
        dy === 0 ? Infinity : (cy - EDGE_MARGIN) / Math.abs(dy),
      );
      x = cx + dx * scale;
      y = cy + dy * scale;
      angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
    const mode = inside ? "pin" : "edge";
    if (marker.mode !== mode) {
      marker.mode = mode;
      marker.root.dataset.mode = mode;
      marker.root.hidden = false;
      if (mode === "pin") marker.pinHalf = marker.pin.offsetWidth / 2;
    }
    // A pin near the side keeps its label on screen; the arrow under it stays on the counter.
    const shift = inside
      ? `${(Math.min(Math.max(x, marker.pinHalf + 6), width - marker.pinHalf - 6) - x).toFixed(0)}px`
      : "0px";
    if (shift !== marker.lastShift) {
      marker.lastShift = shift;
      marker.root.style.setProperty("--pin-shift", shift);
    }
    const transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    if (transform !== marker.lastTransform) {
      marker.lastTransform = transform;
      marker.root.style.transform = transform;
    }
    const turn = `${angle.toFixed(0)}deg`;
    if (marker.root.style.getPropertyValue("--beacon-angle") !== turn) {
      marker.root.style.setProperty("--beacon-angle", turn);
    }
  }

  private hide(marker: Marker): void {
    if (marker.mode === "hidden") return;
    marker.mode = "hidden";
    marker.root.hidden = true;
    marker.lastTransform = "";
  }
}
