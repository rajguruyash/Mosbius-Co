// BFS pathfinding on a tile walkability grid.
// Ported verbatim from shahar061/the-office (office/engine/pathfinding.ts).

interface Point {
  x: number;
  y: number;
}

export interface Walkable {
  width: number;
  height: number;
  isWalkable(x: number, y: number): boolean;
  /** Tiles reachable from (x, y) in one step that are NOT adjacent — doors
   *  that lead to another location (the street door, the fire escape). */
  portalsFrom?(x: number, y: number): Point[];
}


const DIRECTIONS: Point[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

export function findPath(map: Walkable, start: Point, goal: Point): Point[] | null {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!map.isWalkable(goal.x, goal.y)) return null;

  const key = (p: Point) => `${p.x},${p.y}`;
  const visited = new Set<string>();
  const parent = new Map<string, Point>();
  const queue: Point[] = [start];
  visited.add(key(start));

  while (queue.length > 0) {
    const current = queue.shift()!;

    const steps: Point[] = DIRECTIONS.map((dir) => ({ x: current.x + dir.x, y: current.y + dir.y }));
    const jumps = map.portalsFrom?.(current.x, current.y);
    if (jumps) steps.push(...jumps);
    for (const next of steps) {
      const nextKey = key(next);

      if (visited.has(nextKey) || !map.isWalkable(next.x, next.y)) continue;

      visited.add(nextKey);
      parent.set(nextKey, current);

      if (next.x === goal.x && next.y === goal.y) {
        return reconstructPath(parent, start, goal);
      }

      queue.push(next);
    }
  }

  return null;
}

function reconstructPath(parent: Map<string, Point>, start: Point, goal: Point): Point[] {
  const path: Point[] = [];
  let current = goal;
  const key = (p: Point) => `${p.x},${p.y}`;

  while (!(current.x === start.x && current.y === start.y)) {
    path.unshift(current);
    current = parent.get(key(current))!;
  }

  return path;
}
