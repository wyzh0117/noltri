export interface GraphPoint {
  x: number;
  y: number;
}

export interface SimulationNodeInput {
  id: string;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface SimulationLinkInput {
  source: string;
  target: string;
}

export interface GraphForces {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

export interface SimulationNode extends GraphPoint {
  id: string;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  degree: number;
}

export interface SimulationLink {
  source: number;
  target: number;
}

export interface GraphSimulation {
  nodes: SimulationNode[];
  links: SimulationLink[];
  alpha: number;
  alphaTarget: number;
  forces: GraphForces;
}

export const DEFAULT_GRAPH_FORCES: GraphForces = {
  centerStrength: 0.1,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
};

const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
const VELOCITY_DECAY = 0.6;
const CHARGE_DISTANCE_MIN = 30;
const BARNES_HUT_THETA_SQUARED = 0.81;
const COLLISION_RADIUS = 60;
const QUAD_MAX_DEPTH = 20;

interface Quad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mass: number;
  cx: number;
  cy: number;
  indices?: number[];
  children?: Array<Quad | null>;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function initialPoint(id: string, index: number, count: number): GraphPoint {
  const seed = hash(id);
  const angle = seed / 0xffffffff * Math.PI * 2 + index * 2.399963229728653;
  const distance = 60 + Math.sqrt(index + 1) * Math.max(24, Math.sqrt(count) * 0.5);
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export function normalizeGraphForces(forces: Partial<GraphForces> = {}): GraphForces {
  return {
    centerStrength: bounded(forces.centerStrength ?? DEFAULT_GRAPH_FORCES.centerStrength, 0, 1),
    repelStrength: bounded(forces.repelStrength ?? DEFAULT_GRAPH_FORCES.repelStrength, 0, 20),
    linkStrength: bounded(forces.linkStrength ?? DEFAULT_GRAPH_FORCES.linkStrength, 0, 1),
    linkDistance: bounded(forces.linkDistance ?? DEFAULT_GRAPH_FORCES.linkDistance, 30, 500),
  };
}

export function createGraphSimulation(
  inputNodes: readonly SimulationNodeInput[],
  inputLinks: readonly SimulationLinkInput[],
  forces: Partial<GraphForces> = {},
): GraphSimulation {
  const nodes: SimulationNode[] = [];
  const positioned: boolean[] = [];
  const indexById = new Map<string, number>();
  for (const input of inputNodes) {
    if (indexById.has(input.id)) continue;
    indexById.set(input.id, nodes.length);
    const hasPosition = Number.isFinite(input.x) && Number.isFinite(input.y);
    positioned.push(hasPosition);
    nodes.push({
      id: input.id,
      x: hasPosition ? input.x! : 0,
      y: hasPosition ? input.y! : 0,
      vx: 0,
      vy: 0,
      fx: Number.isFinite(input.fx) ? input.fx! : null,
      fy: Number.isFinite(input.fy) ? input.fy! : null,
      degree: 0,
    });
  }
  const newNodeCount = positioned.filter((hasPosition) => !hasPosition).length;

  const links: SimulationLink[] = [];
  const neighbors = nodes.map(() => [] as number[]);
  for (const input of inputLinks) {
    const source = indexById.get(input.source);
    const target = indexById.get(input.target);
    if (source === undefined || target === undefined || source === target) continue;
    links.push({ source, target });
    neighbors[source]!.push(target);
    neighbors[target]!.push(source);
    nodes[source]!.degree += 1;
    nodes[target]!.degree += 1;
  }

  const placeFrom = (seeds: number[]): void => {
    const queue = [...seeds];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const source = queue[cursor]!;
      for (const target of neighbors[source]!) {
        if (positioned[target]) continue;
        const knownNeighbors = neighbors[target]!.filter((index) => positioned[index]);
        if (knownNeighbors.length === 0) continue;
        const mean = knownNeighbors.reduce((point, index) => ({
          x: point.x + nodes[index]!.x / knownNeighbors.length,
          y: point.y + nodes[index]!.y / knownNeighbors.length,
        }), { x: 0, y: 0 });
        const angle = hash(nodes[target]!.id) / 0xffffffff * Math.PI * 2;
        // ponytail: deterministic F=60√I jitter uses I as this batch's new-node count; keep the first layout reproducible.
        const distance = 60 * Math.sqrt(Math.max(1, newNodeCount));
        nodes[target]!.x = mean.x + Math.cos(angle) * distance;
        nodes[target]!.y = mean.y + Math.sin(angle) * distance;
        positioned[target] = true;
        queue.push(target);
      }
    }
  };

  placeFrom(nodes.flatMap((_, index) => positioned[index] ? [index] : []));
  let isolatedIndex = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    if (positioned[index]) continue;
    const fallback = initialPoint(nodes[index]!.id, isolatedIndex++, nodes.length);
    nodes[index]!.x = fallback.x;
    nodes[index]!.y = fallback.y;
    positioned[index] = true;
    placeFrom([index]);
  }

  return { nodes, links, alpha: 1, alphaTarget: 0, forces: normalizeGraphForces(forces) };
}

function buildQuad(nodes: readonly SimulationNode[]): Quad | null {
  if (nodes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x);
    y1 = Math.max(y1, node.y);
  }
  const extent = Math.max(1, x1 - x0, y1 - y0);
  const pad = extent * 1e-6 + 1e-6;
  x0 -= pad;
  y0 -= pad;
  x1 = x0 + extent + pad * 2;
  y1 = y0 + extent + pad * 2;

  const build = (
    indices: number[],
    left: number,
    top: number,
    right: number,
    bottom: number,
    depth: number,
    aggregate?: { mass: number; x: number; y: number },
  ): Quad => {
    const middleX = (left + right) / 2;
    const middleY = (top + bottom) / 2;
    const canSplit = indices.length > 1 && depth < QUAD_MAX_DEPTH;
    let mass = aggregate?.mass ?? 0;
    let cx = aggregate?.x ?? 0;
    let cy = aggregate?.y ?? 0;
    const buckets: number[][] | null = canSplit ? [[], [], [], []] : null;
    const bucketAggregates = canSplit ? [0, 0, 0, 0].map(() => ({ mass: 0, x: 0, y: 0 })) : null;
    if (buckets !== null && bucketAggregates !== null) {
      for (const index of indices) {
        const node = nodes[index]!;
        if (aggregate === undefined) {
          mass += 1;
          cx += node.x;
          cy += node.y;
        }
        const quadrant = (node.x >= middleX ? 1 : 0) + (node.y >= middleY ? 2 : 0);
        buckets[quadrant]!.push(index);
        const childAggregate = bucketAggregates[quadrant]!;
        childAggregate.mass += 1;
        childAggregate.x += node.x;
        childAggregate.y += node.y;
      }
    } else if (aggregate === undefined) {
      for (const index of indices) {
        const node = nodes[index]!;
        mass += 1;
        cx += node.x;
        cy += node.y;
      }
    }
    const quad: Quad = { x0: left, y0: top, x1: right, y1: bottom, mass, cx: cx / mass, cy: cy / mass };
    if (buckets === null || bucketAggregates === null) {
      quad.indices = indices;
      return quad;
    }

    quad.children = buckets.map((bucket, quadrant) => {
      const rightSide = (quadrant & 1) !== 0;
      const bottomSide = (quadrant & 2) !== 0;
      return bucket.length === 0 ? null : build(
        bucket,
        rightSide ? middleX : left,
        bottomSide ? middleY : top,
        rightSide ? right : middleX,
        bottomSide ? bottom : middleY,
        depth + 1,
        bucketAggregates[quadrant],
      );
    });
    return quad;
  };

  return build(nodes.map((_, index) => index), x0, y0, x1, y1, 0);
}

function addChargeForces(simulation: GraphSimulation, fx: number[], fy: number[]): void {
  const root = buildQuad(simulation.nodes);
  if (root === null || simulation.forces.repelStrength === 0) return;
  const charge = -(simulation.forces.repelStrength ** 3);
  const minimumDistanceSquared = CHARGE_DISTANCE_MIN ** 2;

  const apply = (quad: Quad, target: SimulationNode, targetIndex: number, containsTarget: boolean): void => {
    if (quad.indices !== undefined) {
      for (const otherIndex of quad.indices) {
        if (otherIndex === targetIndex) continue;
        const other = simulation.nodes[otherIndex]!;
        let dx = other.x - target.x;
        let dy = other.y - target.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1e-12) {
          const angle = hash(`${target.id}\0${other.id}`) / 0xffffffff * Math.PI * 2;
          dx = Math.cos(angle) * 1e-3;
          dy = Math.sin(angle) * 1e-3;
          distanceSquared = dx * dx + dy * dy;
        }
        const strength = charge * simulation.alpha / Math.max(distanceSquared, minimumDistanceSquared);
        fx[targetIndex]! += dx * strength;
        fy[targetIndex]! += dy * strength;
      }
      return;
    }

    const children = quad.children;
    if (children === undefined) return;
    if (containsTarget) {
      const middleX = (quad.x0 + quad.x1) / 2;
      const middleY = (quad.y0 + quad.y1) / 2;
      const targetQuadrant = (target.x >= middleX ? 1 : 0) + (target.y >= middleY ? 2 : 0);
      for (let quadrant = 0; quadrant < children.length; quadrant += 1) {
        const child = children[quadrant]!;
        if (child !== null) apply(child, target, targetIndex, containsTarget && quadrant === targetQuadrant);
      }
      return;
    }

    const dx = quad.cx - target.x;
    const dy = quad.cy - target.y;
    const distanceSquared = dx * dx + dy * dy;
    const width = quad.x1 - quad.x0;
    if (width * width / BARNES_HUT_THETA_SQUARED >= distanceSquared) {
      const middleX = (quad.x0 + quad.x1) / 2;
      const middleY = (quad.y0 + quad.y1) / 2;
      const targetQuadrant = (target.x >= middleX ? 1 : 0) + (target.y >= middleY ? 2 : 0);
      for (let quadrant = 0; quadrant < children.length; quadrant += 1) {
        const child = children[quadrant]!;
        if (child !== null) apply(child, target, targetIndex, false);
      }
      return;
    }

    let aggregateDx = dx;
    let aggregateDy = dy;
    let aggregateDistanceSquared = distanceSquared;
    if (aggregateDistanceSquared < 1e-12) {
      aggregateDx = 1e-3;
      aggregateDy = -1e-3;
      aggregateDistanceSquared = aggregateDx * aggregateDx + aggregateDy * aggregateDy;
    }
    const strength = charge * quad.mass * simulation.alpha / Math.max(aggregateDistanceSquared, minimumDistanceSquared);
    fx[targetIndex]! += aggregateDx * strength;
    fy[targetIndex]! += aggregateDy * strength;
  };

  for (let index = 0; index < simulation.nodes.length; index += 1) apply(root, simulation.nodes[index]!, index, true);
}

function addCollisionForces(simulation: GraphSimulation, fx: number[], fy: number[]): void {
  const cellSize = COLLISION_RADIUS * 2;
  const cellX = new Array<number>(simulation.nodes.length);
  const cellY = new Array<number>(simulation.nodes.length);
  let minimumX = Infinity;
  let maximumX = -Infinity;
  let minimumY = Infinity;
  let maximumY = -Infinity;
  for (let index = 0; index < simulation.nodes.length; index += 1) {
    const node = simulation.nodes[index]!;
    const x = Math.floor(node.x / cellSize);
    const y = Math.floor(node.y / cellSize);
    cellX[index] = x;
    cellY[index] = y;
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }
  const originX = minimumX - 1;
  const originY = minimumY - 1;
  const width = maximumY - minimumY + 3;
  const keySpace = (maximumX - minimumX + 3) * width;
  const useNumericKeys = simulation.nodes.length === 0 || (
    Number.isSafeInteger(originX) && Number.isSafeInteger(maximumX + 1) &&
    Number.isSafeInteger(originY) && Number.isSafeInteger(maximumY + 1) &&
    Number.isSafeInteger(width) && Number.isSafeInteger(keySpace)
  );
  const cells = new Map<number | string, number[]>();
  const key = (x: number, y: number): number | string => useNumericKeys
    ? (x - originX) * width + (y - originY)
    : `${x},${y}`;
  for (let index = 0; index < simulation.nodes.length; index += 1) {
    const bucketKey = key(cellX[index]!, cellY[index]!);
    const bucket = cells.get(bucketKey);
    if (bucket === undefined) cells.set(bucketKey, [index]);
    else bucket.push(index);
  }

  const minimumDistance = COLLISION_RADIUS * 2;
  for (let left = 0; left < simulation.nodes.length; left += 1) {
    const first = simulation.nodes[left]!;
    for (let y = cellY[left]! - 1; y <= cellY[left]! + 1; y += 1) {
      for (let x = cellX[left]! - 1; x <= cellX[left]! + 1; x += 1) {
        for (const right of cells.get(key(x, y)) ?? []) {
          if (right <= left) continue;
          const second = simulation.nodes[right]!;
          let dx = second.x - first.x;
          let dy = second.y - first.y;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= minimumDistance * minimumDistance) continue;
          if (distanceSquared < 1e-12) {
            const angle = hash(`${first.id}\0${second.id}`) / 0xffffffff * Math.PI * 2;
            dx = Math.cos(angle) * 1e-3;
            dy = Math.sin(angle) * 1e-3;
            distanceSquared = dx * dx + dy * dy;
          }
          const distance = Math.sqrt(distanceSquared);
          const push = (minimumDistance - distance) / distance * 0.5;
          const firstShare = 0.5;
          const secondShare = 1 - firstShare;
          fx[left]! -= dx * push * firstShare;
          fy[left]! -= dy * push * firstShare;
          fx[right]! += dx * push * secondShare;
          fy[right]! += dy * push * secondShare;
        }
      }
    }
  }
}

export function tickGraphSimulation(simulation: GraphSimulation, iterations = 1): void {
  const count = Math.max(0, Math.min(10, Math.floor(iterations)));
  for (let tick = 0; tick < count; tick += 1) {
    simulation.alpha += (simulation.alphaTarget - simulation.alpha) * ALPHA_DECAY;
    if (simulation.alpha < 0.001 && simulation.alphaTarget === 0) return;

    const fx = new Array<number>(simulation.nodes.length).fill(0);
    const fy = new Array<number>(simulation.nodes.length).fill(0);
    const center = simulation.forces.centerStrength * simulation.alpha;
    for (let index = 0; index < simulation.nodes.length; index += 1) {
      const node = simulation.nodes[index]!;
      fx[index]! -= node.x * center;
      fy[index]! -= node.y * center;
    }

    addChargeForces(simulation, fx, fy);
    addCollisionForces(simulation, fx, fy);

    for (const link of simulation.links) {
      const source = simulation.nodes[link.source]!;
      const target = simulation.nodes[link.target]!;
      let dx = target.x - source.x;
      let dy = target.y - source.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 1e-6) {
        const angle = hash(`${source.id}\0${target.id}`) / 0xffffffff * Math.PI * 2;
        dx = Math.cos(angle) * 1e-3;
        dy = Math.sin(angle) * 1e-3;
        distance = Math.hypot(dx, dy);
      }
      const denominator = Math.max(1, Math.min(source.degree, target.degree));
      const strength = simulation.forces.linkStrength * simulation.alpha / denominator;
      const pull = (distance - simulation.forces.linkDistance) / distance * strength;
      const bias = source.degree / Math.max(1, source.degree + target.degree);
      const x = dx * pull;
      const y = dy * pull;
      fx[link.source]! += x * bias;
      fy[link.source]! += y * bias;
      fx[link.target]! -= x * (1 - bias);
      fy[link.target]! -= y * (1 - bias);
    }

    for (let index = 0; index < simulation.nodes.length; index += 1) {
      const node = simulation.nodes[index]!;
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx = (node.vx + fx[index]!) * VELOCITY_DECAY;
      node.vy = (node.vy + fy[index]!) * VELOCITY_DECAY;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > 80) {
        node.vx *= 80 / speed;
        node.vy *= 80 / speed;
      }
      node.x += node.vx;
      node.y += node.vy;
    }
  }
}

export function setSimulationPin(simulation: GraphSimulation, id: string, point: GraphPoint | null): void {
  const node = simulation.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) return;
  node.fx = point?.x ?? null;
  node.fy = point?.y ?? null;
  if (point !== null) {
    node.x = point.x;
    node.y = point.y;
    node.vx = 0;
    node.vy = 0;
    simulation.alphaTarget = 0.3;
  } else {
    simulation.alphaTarget = 0;
  }
}

export function reheatGraphSimulation(simulation: GraphSimulation, alpha = 0.3): void {
  simulation.alpha = Math.max(simulation.alpha, bounded(alpha, 0, 1));
}

export function simulationPositions(simulation: GraphSimulation): Record<string, GraphPoint> {
  return Object.fromEntries(simulation.nodes.map(({ id, x, y }) => [id, { x, y }]));
}
