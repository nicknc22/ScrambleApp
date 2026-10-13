"use client";
// dnd-kit plumbing for the Teams board.
// - Mouse/pen: PointerSensor (6px distance), but it ignores touch pointers. Otherwise it would grab
//   every touch first (pointerdown fires before touchstart) and the page could never scroll.
// - Touch: TouchSensor with a press delay + tolerance, so a quick swipe scrolls and a press-and-hold
//   picks the player up (it then blocks scrolling while dragging).
// - Keyboard: Space picks up, arrows jump between drop zones, Space/Enter drops, Escape cancels.
//   Enter on a player opens the tap-to-move sheet instead.
import {
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";

export const POOL_ID = "pool";
export const teamDropId = (teamId: string) => `team:${teamId}`;
export const playerDragId = (playerId: string) => `player:${playerId}`;

/** Drop zone id -> team id (null = unassigned pool, undefined = not a drop zone). */
export function teamIdOfDropId(id: UniqueIdentifier | null | undefined): string | null | undefined {
  if (id === POOL_ID) return null;
  if (typeof id === "string" && id.startsWith("team:")) return id.slice(5);
  return undefined;
}

export function playerIdOfDragId(id: UniqueIdentifier | null | undefined): string | null {
  return typeof id === "string" && id.startsWith("player:") ? id.slice(7) : null;
}

/** PointerSensor for mouse and pen only; touch goes to the TouchSensor. */
export class MouseAndPenSensor extends PointerSensor {
  static activators: typeof PointerSensor.activators = [
    {
      eventName: "onPointerDown",
      handler: (event, options) => {
        if (event.nativeEvent.pointerType === "touch") return false;
        return PointerSensor.activators[0].handler(event, options);
      },
    },
  ];
}

export const TOUCH_DELAY_MS = 220;
export const TOUCH_TOLERANCE_PX = 8;

const ARROWS: string[] = [KeyboardCode.Down, KeyboardCode.Right, KeyboardCode.Up, KeyboardCode.Left];

/** Arrow keys jump the dragged player to the next/previous drop zone (zones are stacked vertically). */
export const jumpBetweenZones: KeyboardCoordinateGetter = (event, { context }) => {
  if (!ARROWS.includes(event.code)) return undefined;
  event.preventDefault();
  const { collisionRect, droppableRects, droppableContainers, over } = context;
  if (!collisionRect) return undefined;
  const zones: Array<{ id: UniqueIdentifier; rect: ClientRect }> = [];
  for (const c of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(c.id);
    if (rect) zones.push({ id: c.id, rect });
  }
  if (zones.length === 0) return undefined;
  zones.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const forward = event.code === KeyboardCode.Down || event.code === KeyboardCode.Right;
  let idx = over ? zones.findIndex((z) => z.id === over.id) : -1;
  if (idx < 0) {
    const cy = collisionRect.top + collisionRect.height / 2;
    idx = zones.findIndex((z) => cy >= z.rect.top && cy <= z.rect.top + z.rect.height);
  }
  const nextIdx = idx < 0 ? (forward ? 0 : zones.length - 1) : Math.min(zones.length - 1, Math.max(0, idx + (forward ? 1 : -1)));
  const target = zones[nextIdx].rect;
  // Coordinates are the dragged node's top-left: park it just inside the target zone.
  return { x: target.left + 12, y: target.top + 12 };
};

/** Pointer inside a zone wins; keyboard (no pointer) falls back to rectangle overlap. */
export const zoneCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length > 0) return within;
  return rectIntersection(args);
};

export function useBoardSensors() {
  return useSensors(
    useSensor(MouseAndPenSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_DELAY_MS, tolerance: TOUCH_TOLERANCE_PX } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: jumpBetweenZones,
      keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space, KeyboardCode.Enter] },
    }),
  );
}
