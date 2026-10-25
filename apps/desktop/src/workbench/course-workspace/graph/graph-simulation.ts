export interface ForceNode { id: string; x: number; y: number; vx: number; vy: number; radius: number; fx?: number; fy?: number }
export interface ForceEdge { from: string; to: string }
export interface ForceSettings { center: number; repulsion: number; linkStrength: number; linkDistance: number }
export const DEFAULT_FORCES: ForceSettings = { center: 0.1, repulsion: 10, linkStrength: 1, linkDistance: 250 };
export const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
interface Cell { x: number; y: number; size: number; mass: number; cx: number; cy: number; points: ForceNode[]; children?: Cell[] }

function tree(nodes: ForceNode[]): Cell {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const root: Cell = { x: minX || 0, y: minY || 0, size: Math.max(1, maxX - minX, maxY - minY) + 1, mass: 0, cx: 0, cy: 0, points: [] };
  function insert(cell: Cell, point: ForceNode, depth: number): void {
    cell.cx = (cell.cx * cell.mass + point.x) / (cell.mass + 1);
    cell.cy = (cell.cy * cell.mass + point.y) / (cell.mass + 1); cell.mass++;
    if (!cell.children && (cell.points.length === 0 || depth >= 24)) { cell.points.push(point); return; }
    if (!cell.children) {
      const h = cell.size / 2;
      cell.children = [0, 1, 2, 3].map(i => ({ x: cell.x + (i % 2) * h, y: cell.y + Math.floor(i / 2) * h, size: h, mass: 0, cx: 0, cy: 0, points: [] }));
      for (const old of cell.points) insert(cell.children[(old.x >= cell.x + h ? 1 : 0) + (old.y >= cell.y + h ? 2 : 0)], old, depth + 1);
      cell.points = [];
    }
    const h = cell.size / 2;
    insert(cell.children[(point.x >= cell.x + h ? 1 : 0) + (point.y >= cell.y + h ? 2 : 0)], point, depth + 1);
  }
  for (const n of nodes) insert(root, n, 0);
  return root;
}

export function initializeForces(ids: readonly {id:string; weight?:number}[], edges: readonly ForceEdge[], previous: Map<string, ForceNode> = new Map()): ForceNode[] {
  const neighbors = new Map<string, string>();
  for (const e of edges) { neighbors.set(e.from, e.to); neighbors.set(e.to, e.from); }
  return ids.map((n, i) => {
    const valid=(p:ForceNode|undefined)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=1e7&&Math.abs(p.y)<=1e7?p:undefined;
    const old = valid(previous.get(n.id)), near = valid(previous.get(neighbors.get(n.id) ?? ''));
    const angle = i * 2.399963229728653, distance = Math.sqrt(i + 1) * 32;
    return { id: n.id, x: old?.x ?? (near ? near.x + Math.cos(angle) * 40 : Math.cos(angle) * distance), y: old?.y ?? (near ? near.y + Math.sin(angle) * 40 : Math.sin(angle) * distance), vx: old?.vx ?? 0, vy: old?.vy ?? 0, radius: Math.min(30, Math.max(8, 3 * Math.sqrt((n.weight ?? 0) + 1))) };
  });
}

/** Independent Barnes–Hut solver; the same path handles small and large graphs. */
export class ForceSimulation {
  alpha = 1;
  alphaTarget = 0;
  private links: { from: ForceNode; to: ForceNode; degree: number }[];
  constructor(public nodes: ForceNode[], edges: readonly ForceEdge[], public settings: ForceSettings = DEFAULT_FORCES) {
    const byId = new Map(nodes.map(n => [n.id, n])), degrees = new Map<string, number>();
    for (const edge of edges) { degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1); degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1); }
    this.links = edges.flatMap(e => { const from = byId.get(e.from), to = byId.get(e.to); return from && to && from !== to ? [{from, to, degree: Math.max(degrees.get(e.from) ?? 1, degrees.get(e.to) ?? 1)}] : []; });
  }
  tick(): boolean {
    if (!this.nodes.length) return false;
    this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY;
    const root = tree(this.nodes), charge = this.settings.repulsion ** 3 * this.alpha;
    const push = (n: ForceNode, x: number, y: number, mass: number): void => {
      let dx = n.x - x, dy = n.y - y;
      if (dx === 0 && dy === 0) { const angle = this.nodes.indexOf(n) * 2.399963; dx = Math.cos(angle) * 0.01; dy = Math.sin(angle) * 0.01; }
      const distance2 = Math.max(900, dx * dx + dy * dy);
      n.vx += dx * charge * mass / distance2; n.vy += dy * charge * mass / distance2;
    };
    for (const n of this.nodes) {
      const visit = (c: Cell): void => {
        if (!c.mass) return;
        const contains = n.x >= c.x && n.x <= c.x + c.size && n.y >= c.y && n.y <= c.y + c.size;
        const d2 = (n.x - c.cx) ** 2 + (n.y - c.cy) ** 2;
        if (!contains && c.size * c.size < 0.81 * d2) { push(n, c.cx, c.cy, c.mass); return; }
        if (c.children) for (const child of c.children) visit(child);
        else for (const other of c.points) if (other !== n) push(n, other.x, other.y, 1);
      };
      visit(root);
      n.vx -= n.x * this.settings.center * this.alpha * 0.01;
      n.vy -= n.y * this.settings.center * this.alpha * 0.01;
    }
    for (const {from, to, degree} of this.links) {
      let dx = to.x + to.vx - from.x - from.vx, dy = to.y + to.vy - from.y - from.vy;
      if (dx === 0 && dy === 0) dx = 0.01;
      const d = Math.hypot(dx, dy), force = (d - this.settings.linkDistance) / d * this.alpha * this.settings.linkStrength / degree * 0.5;
      dx *= force; dy *= force; from.vx += dx; from.vy += dy; to.vx -= dx; to.vy -= dy;
    }
    // Spatial collision buckets avoid an all-pairs scan at large node counts.
    const cells = new Map<string, ForceNode[]>(), size = 120;
    for (const n of this.nodes) { const key = `${Math.floor(n.x / size)},${Math.floor(n.y / size)}`; const bucket = cells.get(key) ?? []; bucket.push(n); cells.set(key, bucket); }
    for (const n of this.nodes) {
      const gx = Math.floor(n.x / size), gy = Math.floor(n.y / size);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (const other of cells.get(`${x},${y}`) ?? []) {
        if (n.id >= other.id) continue;
        let dx = other.x - n.x, dy = other.y - n.y;
        if (dx === 0 && dy === 0) { dx = 0.01; dy = 0.007; }
        const d = Math.hypot(dx, dy), radius = 60 + (n.radius + other.radius) * 0.5;
        if (d >= radius) continue;
        const f = (radius - d) / d * 0.25;
        n.vx -= dx * f; n.vy -= dy * f; other.vx += dx * f; other.vy += dy * f;
      }
    }
    for (const n of this.nodes) {
      if (n.fx !== undefined) { n.x = n.fx; n.vx = 0; } else n.x += n.vx *= 0.6;
      if (n.fy !== undefined) { n.y = n.fy; n.vy = 0; } else n.y += n.vy *= 0.6;
    }
    return this.alpha > 0.001 || this.alphaTarget > 0;
  }
}
