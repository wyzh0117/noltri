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
  degreeDenominator: number;
  sourceBias: number;
}

export interface GraphSimulation {
  nodes: SimulationNode[];
  links: SimulationLink[];
  alpha: number;
  alphaTarget: number;
  forces: GraphForces;
  workspace: SimulationWorkspace;
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
  middleX: number;
  middleY: number;
  openingDistanceSquared: number;
  mass: number;
  cx: number;
  cy: number;
  indices?: number[];
  children: Array<Quad | null>;
  buckets: [number[], number[], number[], number[]];
  bucketMass: [number, number, number, number];
  bucketX: [number, number, number, number];
  bucketY: [number, number, number, number];
}

interface SimulationWorkspace {
  forceX: number[];
  forceY: number[];
  quads: Quad[];
  quadCursor: number;
  quadPoints: number[];
  quadStack: Quad[];
  containsTarget: Uint8Array;
  cellX: number[];
  cellY: number[];
  cells: Map<number | string, number[]>;
  cellBuckets: number[][];
  cellBucketCursor: number;
}

function createSimulationWorkspace(nodeCount: number): SimulationWorkspace {
  return {
    forceX: new Array<number>(nodeCount),
    forceY: new Array<number>(nodeCount),
    quads: [],
    quadCursor: 0,
    quadPoints: new Array<number>(nodeCount),
    quadStack: new Array<Quad>(Math.max(64, nodeCount * 4)),
    containsTarget: new Uint8Array(Math.max(64, nodeCount * 4)),
    cellX: new Array<number>(nodeCount),
    cellY: new Array<number>(nodeCount),
    cells: new Map(),
    cellBuckets: [],
    cellBucketCursor: 0,
  };
}

function createQuad(): Quad {
  return {
    x0: 0, y0: 0, x1: 0, y1: 0, middleX: 0, middleY: 0, openingDistanceSquared: 0, mass: 0, cx: 0, cy: 0,
    children: [null, null, null, null],
    buckets: [[], [], [], []],
    bucketMass: [0, 0, 0, 0],
    bucketX: [0, 0, 0, 0],
    bucketY: [0, 0, 0, 0],
  };
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
  const links: SimulationLink[] = [];
  const neighbors = nodes.map(() => [] as number[]);
  for (const input of inputLinks) {
    const source = indexById.get(input.source);
    const target = indexById.get(input.target);
    if (source === undefined || target === undefined || source === target) continue;
    links.push({ source, target, degreeDenominator: 1, sourceBias: 0.5 });
    neighbors[source]!.push(target);
    neighbors[target]!.push(source);
    nodes[source]!.degree += 1;
    nodes[target]!.degree += 1;
  }
  for (const link of links) {
    const sourceDegree = nodes[link.source]!.degree;
    const targetDegree = nodes[link.target]!.degree;
    link.degreeDenominator = Math.max(1, Math.min(sourceDegree, targetDegree));
    link.sourceBias = sourceDegree / Math.max(1, sourceDegree + targetDegree);
  }

  const placedByNeighbor = new Map<number, number>();
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
        const anchor = knownNeighbors[0]!;
        const ordinal = (placedByNeighbor.get(anchor) ?? 0) + 1;
        placedByNeighbor.set(anchor, ordinal);
        const distance = 60 * Math.sqrt(ordinal);
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

  return { nodes, links, alpha: 1, alphaTarget: 0, forces: normalizeGraphForces(forces), workspace: createSimulationWorkspace(nodes.length) };
}

function buildQuad(nodes: readonly SimulationNode[], workspace: SimulationWorkspace): Quad | null {
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
  workspace.quadCursor = 0;
  for (let index = 0; index < nodes.length; index += 1) workspace.quadPoints[index] = index;

  const build = (
    indices: number[],
    left: number,
    top: number,
    right: number,
    bottom: number,
    depth: number,
    aggregateMass = 0,
    aggregateX = 0,
    aggregateY = 0,
  ): Quad => {
    const quad = workspace.quads[workspace.quadCursor] ?? createQuad();
    workspace.quads[workspace.quadCursor] = quad;
    workspace.quadCursor += 1;
    quad.x0 = left;
    quad.y0 = top;
    quad.x1 = right;
    quad.y1 = bottom;
    quad.indices = undefined;
    const middleX = (left + right) / 2;
    const middleY = (top + bottom) / 2;
    quad.middleX = middleX;
    quad.middleY = middleY;
    const width = right - left;
    quad.openingDistanceSquared = width * width / BARNES_HUT_THETA_SQUARED;
    const canSplit = indices.length > 1 && depth < QUAD_MAX_DEPTH;
    let mass = aggregateMass;
    let cx = aggregateX;
    let cy = aggregateY;
    if (canSplit) {
      quad.children.fill(null);
      for (let quadrant = 0; quadrant < 4; quadrant += 1) {
        quad.buckets[quadrant]!.length = 0;
        quad.bucketMass[quadrant] = 0;
        quad.bucketX[quadrant] = 0;
        quad.bucketY[quadrant] = 0;
      }
    }
    if (canSplit) {
      for (const index of indices) {
        const node = nodes[index]!;
        if (aggregateMass === 0) {
          mass += 1;
          cx += node.x;
          cy += node.y;
        }
        const quadrant = (node.x >= middleX ? 1 : 0) + (node.y >= middleY ? 2 : 0);
        quad.buckets[quadrant]!.push(index);
        quad.bucketMass[quadrant] += 1;
        quad.bucketX[quadrant] += node.x;
        quad.bucketY[quadrant] += node.y;
      }
    } else if (aggregateMass === 0) {
      for (const index of indices) {
        const node = nodes[index]!;
        mass += 1;
        cx += node.x;
        cy += node.y;
      }
    }
    quad.mass = mass;
    quad.cx = cx / mass;
    quad.cy = cy / mass;
    if (!canSplit) {
      quad.indices = indices;
      return quad;
    }

    for (let quadrant = 0; quadrant < 4; quadrant += 1) {
      const bucket = quad.buckets[quadrant]!;
      if (bucket.length === 0) continue;
      const rightSide = (quadrant & 1) !== 0;
      const bottomSide = (quadrant & 2) !== 0;
      quad.children[quadrant] = build(
        bucket,
        rightSide ? middleX : left,
        bottomSide ? middleY : top,
        rightSide ? right : middleX,
        bottomSide ? bottom : middleY,
        depth + 1,
        quad.bucketMass[quadrant]!, quad.bucketX[quadrant]!, quad.bucketY[quadrant]!,
      );
    }
    return quad;
  };

  return build(workspace.quadPoints, x0, y0, x1, y1, 0);
}

function addChargeForces(simulation: GraphSimulation, fx: number[], fy: number[]): void {
  const workspace = simulation.workspace;
  const root = buildQuad(simulation.nodes, workspace);
  if (root === null || simulation.forces.repelStrength === 0) return;
  const charge = -(simulation.forces.repelStrength ** 3);
  const chargeAlpha = charge * simulation.alpha;
  const minimumDistanceSquared = CHARGE_DISTANCE_MIN ** 2;

  const stack = workspace.quadStack;
  const containsTarget = workspace.containsTarget;
  for (let index = 0; index < simulation.nodes.length; index += 1) {
    const target = simulation.nodes[index]!;
    const targetX = target.x;
    const targetY = target.y;
    let top = 0;
    stack[0] = root;
    containsTarget[0] = 1;
    while (top >= 0) {
      const quad = stack[top]!;
      const includesTarget = containsTarget[top] === 1;
      top -= 1;
      const indices = quad.indices;
      if (indices !== undefined) {
        for (const otherIndex of indices) {
          if (otherIndex === index) continue;
          const other = simulation.nodes[otherIndex]!;
          let dx = other.x - targetX;
          let dy = other.y - targetY;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < 1e-12) {
            const angle = hash(`${target.id}\0${other.id}`) / 0xffffffff * Math.PI * 2;
            dx = Math.cos(angle) * 1e-6;
            dy = Math.sin(angle) * 1e-6;
            distanceSquared = dx * dx + dy * dy;
          }
          const strength = chargeAlpha / Math.max(distanceSquared, minimumDistanceSquared);
          fx[index]! += dx * strength;
          fy[index]! += dy * strength;
        }
        continue;
      }

      const children = quad.children;
      if (includesTarget) {
        const targetQuadrant = (target.x >= quad.middleX ? 1 : 0) + (target.y >= quad.middleY ? 2 : 0);
        for (let quadrant = 0; quadrant < 4; quadrant += 1) {
          const child = children[quadrant];
          if (child === null || child === undefined) continue;
          top += 1;
          stack[top] = child;
          containsTarget[top] = quadrant === targetQuadrant ? 1 : 0;
        }
        continue;
      }
      const dx = quad.cx - targetX;
      const dy = quad.cy - targetY;
      const distanceSquared = dx * dx + dy * dy;
      if (quad.openingDistanceSquared >= distanceSquared) {
        for (let quadrant = 0; quadrant < 4; quadrant += 1) {
          const child = children[quadrant];
          if (child === null || child === undefined) continue;
          top += 1;
          stack[top] = child;
          containsTarget[top] = 0;
        }
        continue;
      }

      let aggregateDx = dx;
      let aggregateDy = dy;
      let aggregateDistanceSquared = distanceSquared;
      if (aggregateDistanceSquared < 1e-12) {
        aggregateDx = 1e-3;
        aggregateDy = -1e-3;
        aggregateDistanceSquared = aggregateDx * aggregateDx + aggregateDy * aggregateDy;
      }
      const strength = chargeAlpha * quad.mass / Math.max(aggregateDistanceSquared, minimumDistanceSquared);
      fx[index]! += aggregateDx * strength;
      fy[index]! += aggregateDy * strength;
    }
  }
}

function addCollisionForces(simulation: GraphSimulation, fx: number[], fy: number[]): void {
  const workspace = simulation.workspace;
  const cellSize = COLLISION_RADIUS * 2;
  const cellX = workspace.cellX;
  const cellY = workspace.cellY;
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
  const useNumericKeys = Number.isSafeInteger(originX) && Number.isSafeInteger(maximumX + 1)
    && Number.isSafeInteger(originY) && Number.isSafeInteger(maximumY + 1)
    && Number.isSafeInteger(width) && Number.isSafeInteger(keySpace);
  const cells = workspace.cells;
  cells.clear();
  workspace.cellBucketCursor = 0;
  const key = (x: number, y: number): number | string => useNumericKeys
    ? (x - originX) * width + (y - originY)
    : `${x},${y}`;
  for (let index = 0; index < simulation.nodes.length; index += 1) {
    const bucketKey = key(cellX[index]!, cellY[index]!);
    let bucket = cells.get(bucketKey);
    if (bucket === undefined) {
      bucket = workspace.cellBuckets[workspace.cellBucketCursor];
      if (bucket === undefined) bucket = workspace.cellBuckets[workspace.cellBucketCursor] = [];
      workspace.cellBucketCursor += 1;
      bucket.length = 0;
      cells.set(bucketKey, bucket);
    }
    bucket.push(index);
  }

  const minimumDistance = cellSize;
  const minimumDistanceSquared = minimumDistance * minimumDistance;
  if (useNumericKeys) {
    for (let left = 0; left < simulation.nodes.length; left += 1) {
      const first = simulation.nodes[left]!;
      const ownCellKey = (cellX[left]! - originX) * width + (cellY[left]! - originY);
      let neighborKey = ownCellKey;
      for (let neighbor = 0; neighbor < 5; neighbor += 1) {
        if (neighbor === 1) neighborKey = ownCellKey + width;
        else if (neighbor === 2) neighborKey = ownCellKey + 1;
        else if (neighbor === 3) neighborKey = ownCellKey + width + 1;
        else if (neighbor === 4) neighborKey = ownCellKey - width + 1;
        const nearby = cells.get(neighborKey);
        if (nearby === undefined) continue;
        for (const right of nearby) {
          if (neighbor === 0 && right <= left) continue;
          const second = simulation.nodes[right]!;
          let dx = second.x - first.x;
          let dy = second.y - first.y;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= minimumDistanceSquared) continue;
          if (distanceSquared < 1e-12) {
            const angle = hash(`${first.id}\0${second.id}`) / 0xffffffff * Math.PI * 2;
            dx = Math.cos(angle) * 1e-6;
            dy = Math.sin(angle) * 1e-6;
            distanceSquared = dx * dx + dy * dy;
          }
          const distance = Math.sqrt(distanceSquared);
          const push = (minimumDistance - distance) / distance * 0.5;
          fx[left]! -= dx * push * 0.5;
          fy[left]! -= dy * push * 0.5;
          fx[right]! += dx * push * 0.5;
          fy[right]! += dy * push * 0.5;
        }
      }
    }
    return;
  }
  for (let left = 0; left < simulation.nodes.length; left += 1) {
    const first = simulation.nodes[left]!;
    for (let y = cellY[left]! - 1; y <= cellY[left]! + 1; y += 1) {
      for (let x = cellX[left]! - 1; x <= cellX[left]! + 1; x += 1) {
        const nearby = cells.get(`${x},${y}`);
        if (nearby === undefined) continue;
        for (const right of nearby) {
          if (right <= left) continue;
          const second = simulation.nodes[right]!;
          let dx = second.x - first.x;
          let dy = second.y - first.y;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= minimumDistanceSquared) continue;
          if (distanceSquared < 1e-12) {
            const angle = hash(`${first.id}\0${second.id}`) / 0xffffffff * Math.PI * 2;
            dx = Math.cos(angle) * 1e-6;
            dy = Math.sin(angle) * 1e-6;
            distanceSquared = dx * dx + dy * dy;
          }
          const distance = Math.sqrt(distanceSquared);
          const push = (minimumDistance - distance) / distance * 0.5;
          fx[left]! -= dx * push * 0.5;
          fy[left]! -= dy * push * 0.5;
          fx[right]! += dx * push * 0.5;
          fy[right]! += dy * push * 0.5;
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

    const fx = simulation.workspace.forceX;
    const fy = simulation.workspace.forceY;
    fx.fill(0);
    fy.fill(0);
    const center = simulation.forces.centerStrength * simulation.alpha;
    for (let index = 0; index < simulation.nodes.length; index += 1) {
      const node = simulation.nodes[index]!;
      fx[index]! -= node.x * center;
      fy[index]! -= node.y * center;
    }

    addChargeForces(simulation, fx, fy);
    addCollisionForces(simulation, fx, fy);

    const linkStrength = simulation.forces.linkStrength * simulation.alpha;
    for (const link of simulation.links) {
      const source = simulation.nodes[link.source]!;
      const target = simulation.nodes[link.target]!;
      let dx = target.x - source.x;
      let dy = target.y - source.y;
      let distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 1e-6) {
        const angle = hash(`${source.id}\0${target.id}`) / 0xffffffff * Math.PI * 2;
        dx = Math.cos(angle) * 1e-6;
        dy = Math.sin(angle) * 1e-6;
        distance = Math.sqrt(dx * dx + dy * dy);
      }
      const strength = linkStrength / link.degreeDenominator;
      const pull = (distance - simulation.forces.linkDistance) / distance * strength;
      const x = dx * pull;
      const y = dy * pull;
      fx[link.source]! += x * link.sourceBias;
      fy[link.source]! += y * link.sourceBias;
      fx[link.target]! -= x * (1 - link.sourceBias);
      fy[link.target]! -= y * (1 - link.sourceBias);
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
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
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
