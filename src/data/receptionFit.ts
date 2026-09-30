import type { MovementBounds } from "../entities/Player";

/**
 * Whether a scenario's reception area actually sits inside a map's playable bounds.
 *
 * A custom map rarely uses the wedding kitchen's coordinates, and dropping the reception
 * carpet at fixed world coordinates would leave it hanging outside the room. When it does not
 * fit, the crowd falls back to deriving an area from the bounds it was given.
 */
export const areaFitsWithin = (
  area: MovementBounds,
  bounds: MovementBounds,
): boolean =>
  area.minX >= bounds.minX &&
  area.maxX <= bounds.maxX &&
  area.minZ >= bounds.minZ &&
  area.maxZ <= bounds.maxZ &&
  area.maxX > area.minX &&
  area.maxZ > area.minZ;
