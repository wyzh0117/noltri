import type { GraphModel } from './workbench-graph-model';
import { graphNodeScreenRadius, graphPointToScreen, graphSegmentCoordinatesVisibleInViewport, resolveGraphLabelIds } from './workbench-graph-view-model';
import type { GraphCamera, GraphLabelMode, GraphViewport } from './workbench-graph-view-model';
import type { GraphPoint } from './workbench-graph-simulation';

export interface GraphPalette {
  line: string;
  node: string;
  text: string;
  muted: string;
  discipline: string;
  subdiscipline: string;
  domain: string;
  topic: string;
  chapter: string;
  focused: string;
  selected: string;
}

export const DEFAULT_GRAPH_PALETTE: GraphPalette = {
  line: '#d8ddd4', node: '#89978c', text: '#48534b', muted: '#899188',
  discipline: '#2f5542', subdiscipline: '#527e67', domain: '#9a7f50',
  topic: '#3d6853', chapter: '#89978c', focused: '#3d6853', selected: '#3d6853',
};

export function graphPaletteFromElement(element: HTMLElement): GraphPalette {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    line: read('--line', DEFAULT_GRAPH_PALETTE.line),
    node: read('--muted', DEFAULT_GRAPH_PALETTE.node),
    text: read('--ink-soft', DEFAULT_GRAPH_PALETTE.text),
    muted: read('--muted', DEFAULT_GRAPH_PALETTE.muted),
    discipline: read('--ink', DEFAULT_GRAPH_PALETTE.discipline),
    subdiscipline: read('--green-dark', DEFAULT_GRAPH_PALETTE.subdiscipline),
    domain: DEFAULT_GRAPH_PALETTE.domain,
    topic: read('--green', DEFAULT_GRAPH_PALETTE.topic),
    chapter: read('--muted', DEFAULT_GRAPH_PALETTE.chapter),
    focused: read('--green', DEFAULT_GRAPH_PALETTE.focused),
    selected: read('--green', DEFAULT_GRAPH_PALETTE.selected),
  };
}

export interface GraphRenderInput {
  model: GraphModel;
  positions: Readonly<Record<string, GraphPoint>>;
  camera: GraphCamera;
  viewport: GraphViewport;
  palette: GraphPalette;
  selectedId: string | null;
  focusedId: string | null;
  hoveredId: string | null;
  labelMode: GraphLabelMode;
  showArrows: boolean;
}

export function uniqueGraphLineEdges(edges: readonly GraphModel['edges'][number][]): GraphModel['edges'] {
  const unique = new Map<string, GraphModel['edges'][number]>();
  for (const edge of edges) {
    const first = edge.source < edge.target ? edge.source : edge.target;
    const second = edge.source < edge.target ? edge.target : edge.source;
    const key = `${first}\0${second}`;
    const previous = unique.get(key);
    if (previous === undefined || edge.width > previous.width) unique.set(key, edge);
  }
  return [...unique.values()];
}

type RenderMode = 'webgl' | 'canvas';

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec4 a_color;
attribute float a_size;
varying vec4 v_color;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  gl_PointSize = a_size;
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform float u_round_points;
varying vec4 v_color;
void main() {
  if (u_round_points > 0.5 && distance(gl_PointCoord, vec2(0.5, 0.5)) > 0.5) discard;
  gl_FragColor = v_color;
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('Unable to create graph shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unable to compile graph shader';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (program === null) throw new Error('Unable to create graph program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unable to link graph program';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function rgba(context: CanvasRenderingContext2D, color: string, alpha = 1): [number, number, number, number] {
  context.fillStyle = '#000000';
  context.fillStyle = color;
  const normalized = context.fillStyle;
  const hex = normalized.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex !== undefined) {
    return [Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255, alpha];
  }
  const parts = normalized.match(/^rgba?\(([^)]+)\)$/i)?.[1]?.split(/[\s,\/]+/).filter(Boolean);
  if (parts === undefined || parts.length < 3) return [0.28, 0.34, 0.3, alpha];
  const channel = (part: string): number => (part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part)) / 255;
  return [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha * (parts[3] === undefined ? 1 : Number.parseFloat(parts[3]!))];
}

function ensureVertexCapacity(buffer: Float32Array<ArrayBuffer>, required: number): Float32Array<ArrayBuffer> {
  if (buffer.length >= required) return buffer;
  let capacity = Math.max(256, buffer.length);
  while (capacity < required) capacity *= 2;
  return new Float32Array(capacity);
}

function addVertex(target: Float32Array<ArrayBuffer>, offset: number, x: number, y: number, color: [number, number, number, number], size: number, viewport: GraphViewport): number {
  target[offset++] = x / viewport.width * 2 - 1;
  target[offset++] = 1 - y / viewport.height * 2;
  target[offset++] = color[0];
  target[offset++] = color[1];
  target[offset++] = color[2];
  target[offset++] = color[3];
  target[offset++] = size;
  return offset;
}

function nodeColor(node: GraphModel['nodes'][number], input: GraphRenderInput): string {
  if (node.id === input.selectedId) return input.palette.selected;
  if (node.id === input.hoveredId) return input.palette.focused;
  if (node.id === input.focusedId) return input.palette.focused;
  if (node.colorGroup !== null) return node.colorGroup;
  switch (node.type) {
    case 'discipline': return input.palette.discipline;
    case 'subdiscipline': return input.palette.subdiscipline;
    case 'domain': return input.palette.domain;
    case 'topic': return input.palette.topic;
    case 'chapter': return input.palette.chapter;
  }
}

export class WorkbenchGraphRenderer {
  readonly mode: RenderMode;
  readonly fallbackReason: string | null;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly program: WebGLProgram | null;
  private readonly vertexBuffer: WebGLBuffer | null;
  private readonly positionAttribute: number;
  private readonly colorAttribute: number;
  private readonly sizeAttribute: number;
  private readonly roundPointsUniform: WebGLUniformLocation | null;
  private readonly fallbackContext: CanvasRenderingContext2D | null;
  private readonly labelContext: CanvasRenderingContext2D;
  private readonly webglCanvas: HTMLCanvasElement;
  private readonly fallbackCanvas: HTMLCanvasElement;
  private readonly labelCanvas: HTMLCanvasElement;
  private dpr = 1;
  private edgeVertices = new Float32Array(0);
  private haloVertices = new Float32Array(0);
  private nodeVertices = new Float32Array(0);
  private gpuBufferBytes = 0;
  private indexedModel: GraphModel | null = null;
  private lineEdges: GraphModel['edges'] = [];
  private adjacency = new Map<string, Set<string>>();
  private visibleNodes: GraphModel['nodes'] = [];
  private visibleEdges: GraphModel['edges'] = [];
  private visibleArrows: GraphModel['edges'] = [];
  private neighborhoodKey: string | null = null;
  private neighborhoodModel: GraphModel | null = null;
  private neighborhood: Set<string> | null = null;
  private readonly colorCache = new Map<string, [number, number, number, number]>();
  private labelOrder: GraphModel['nodes'] = [];
  private visibleNodeIds = new Set<string>();
  private orderedVisibleNodes: GraphModel['nodes'] = [];

  constructor(webglCanvas: HTMLCanvasElement, fallbackCanvas: HTMLCanvasElement, labelCanvas: HTMLCanvasElement) {
    this.webglCanvas = webglCanvas;
    this.fallbackCanvas = fallbackCanvas;
    this.labelCanvas = labelCanvas;
    const labelContext = labelCanvas.getContext('2d');
    if (labelContext === null) throw new Error('Canvas 2D is unavailable for graph labels');
    this.labelContext = labelContext;

    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let vertexBuffer: WebGLBuffer | null = null;
    let fallbackReason: string | null = null;
    try {
      gl = webglCanvas.getContext('webgl2', { alpha: true, antialias: true });
      if (gl === null) fallbackReason = 'WebGL2 is unavailable';
      else {
        program = createProgram(gl);
        vertexBuffer = gl.createBuffer();
        if (vertexBuffer === null) throw new Error('Unable to create graph vertex buffer');
      }
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : 'WebGL2 initialization failed';
      if (gl !== null && program !== null) gl.deleteProgram(program);
      gl = null;
      program = null;
      vertexBuffer = null;
    }
    if (gl !== null && program !== null) {
      this.positionAttribute = gl.getAttribLocation(program, 'a_position');
      this.colorAttribute = gl.getAttribLocation(program, 'a_color');
      this.sizeAttribute = gl.getAttribLocation(program, 'a_size');
      this.roundPointsUniform = gl.getUniformLocation(program, 'u_round_points');
      this.mode = 'webgl';
      this.gl = gl;
      this.program = program;
      this.vertexBuffer = vertexBuffer;
      this.fallbackContext = null;
      webglCanvas.hidden = false;
      fallbackCanvas.hidden = true;
    } else {
      this.positionAttribute = -1;
      this.colorAttribute = -1;
      this.sizeAttribute = -1;
      this.roundPointsUniform = null;
      const context = fallbackCanvas.getContext('2d');
      if (context === null) throw new Error('Graph rendering is unavailable: WebGL2 and Canvas 2D could not initialize');
      this.mode = 'canvas';
      this.gl = null;
      this.program = null;
      this.vertexBuffer = null;
      this.fallbackContext = context;
      this.fallbackReason = fallbackReason;
      webglCanvas.hidden = true;
      fallbackCanvas.hidden = false;
      return;
    }
    this.fallbackReason = fallbackReason;
  }

  resize(viewport: GraphViewport, dpr = window.devicePixelRatio || 1): void {
    this.dpr = Math.max(1, Math.min(3, dpr));
    for (const canvas of [this.webglCanvas, this.fallbackCanvas, this.labelCanvas]) {
      canvas.width = Math.max(1, Math.round(viewport.width * this.dpr));
      canvas.height = Math.max(1, Math.round(viewport.height * this.dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
    }
    this.gl?.viewport(0, 0, this.webglCanvas.width, this.webglCanvas.height);
  }

  draw(input: GraphRenderInput): void {
    this.prepareModel(input.model);
    this.collectVisible(input);
    this.drawBase(input);
    this.drawOverlay(input);
  }

  dispose(): void {
    if (this.gl !== null && this.program !== null) this.gl.deleteProgram(this.program);
    if (this.gl !== null && this.vertexBuffer !== null) this.gl.deleteBuffer(this.vertexBuffer);
  }

  private color(color: string, alpha = 1): [number, number, number, number] {
    const key = `${color}\0${alpha}`;
    const cached = this.colorCache.get(key);
    if (cached !== undefined) return cached;
    if (this.colorCache.size >= 128) this.colorCache.clear();
    const parsed = rgba(this.labelContext, color, alpha);
    this.colorCache.set(key, parsed);
    return parsed;
  }

  private prepareModel(model: GraphModel): void {
    if (this.indexedModel === model) return;
    this.indexedModel = model;
    this.adjacency = new Map(model.nodes.map((node) => [node.id, new Set<string>()]));
    for (const edge of model.edges) {
      this.adjacency.get(edge.source)?.add(edge.target);
      this.adjacency.get(edge.target)?.add(edge.source);
    }
    this.lineEdges = uniqueGraphLineEdges(model.edges);
    this.labelOrder = [...model.nodes].sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id));
    this.neighborhoodModel = null;
  }

  private collectVisible(input: GraphRenderInput): void {
    this.visibleNodes.length = 0;
    this.visibleNodeIds.clear();
    this.visibleEdges.length = 0;
    this.visibleArrows.length = 0;
    const { camera, viewport, positions } = input;
    for (const node of input.model.nodes) {
      const point = positions[node.id];
      if (point === undefined) continue;
      const x = viewport.width / 2 + camera.x + point.x * camera.scale;
      const y = viewport.height / 2 + camera.y + point.y * camera.scale;
      const radius = graphNodeScreenRadius(node, camera.scale);
      const margin = radius + Math.min(320, node.title.length * 8 + 16);
      if (x >= -margin && x <= viewport.width + margin && y >= -margin && y <= viewport.height + margin) {
        this.visibleNodes.push(node);
        this.visibleNodeIds.add(node.id);
      }
    }
    for (const edge of this.lineEdges) {
      const source = positions[edge.source];
      const target = positions[edge.target];
      if (source === undefined || target === undefined) continue;
      const x0 = viewport.width / 2 + camera.x + source.x * camera.scale;
      const y0 = viewport.height / 2 + camera.y + source.y * camera.scale;
      const x1 = viewport.width / 2 + camera.x + target.x * camera.scale;
      const y1 = viewport.height / 2 + camera.y + target.y * camera.scale;
      if (graphSegmentCoordinatesVisibleInViewport(x0, y0, x1, y1, viewport)) this.visibleEdges.push(edge);
    }
    this.orderedVisibleNodes.length = 0;
    for (const node of this.labelOrder) if (this.visibleNodeIds.has(node.id)) this.orderedVisibleNodes.push(node);
    if (!input.showArrows) return;
    for (const edge of input.model.edges) {
      const source = positions[edge.source];
      const target = positions[edge.target];
      if (source === undefined || target === undefined) continue;
      const x0 = viewport.width / 2 + camera.x + source.x * camera.scale;
      const y0 = viewport.height / 2 + camera.y + source.y * camera.scale;
      const x1 = viewport.width / 2 + camera.x + target.x * camera.scale;
      const y1 = viewport.height / 2 + camera.y + target.y * camera.scale;
      if (graphSegmentCoordinatesVisibleInViewport(x0, y0, x1, y1, viewport)) this.visibleArrows.push(edge);
    }
  }

  private hoverNeighborhood(input: GraphRenderInput): Set<string> | null {
    if (input.hoveredId === null) return null;
    if (this.neighborhoodModel === input.model && this.neighborhoodKey === input.hoveredId) return this.neighborhood;
    const neighbors = new Set([input.hoveredId, ...(this.adjacency.get(input.hoveredId) ?? [])]);
    this.neighborhoodModel = input.model;
    this.neighborhoodKey = input.hoveredId;
    this.neighborhood = neighbors;
    return neighbors;
  }

  private drawBase(input: GraphRenderInput): void {
    const context = this.fallbackContext;
    if (context !== null) {
      this.drawCanvas2D(context, input);
      return;
    }
    const gl = this.gl;
    const program = this.program;
    if (gl === null || program === null) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    const neighborhood = this.hoverNeighborhood(input);
    let edgeData = ensureVertexCapacity(this.edgeVertices, this.visibleEdges.length * 42);
    let edgeOffset = 0;
    for (const edge of this.visibleEdges) {
      const source = input.positions[edge.source];
      const target = input.positions[edge.target];
      if (source === undefined || target === undefined) continue;
      const sourceX = input.viewport.width / 2 + input.camera.x + source.x * input.camera.scale;
      const sourceY = input.viewport.height / 2 + input.camera.y + source.y * input.camera.scale;
      const targetX = input.viewport.width / 2 + input.camera.x + target.x * input.camera.scale;
      const targetY = input.viewport.height / 2 + input.camera.y + target.y * input.camera.scale;
      const alpha = neighborhood !== null && !neighborhood.has(edge.source) && !neighborhood.has(edge.target) ? 0.16 : 0.8;
      const color = this.color(edge.source === input.hoveredId || edge.target === input.hoveredId ? input.palette.focused : input.palette.line, alpha);
      const dx = targetX - sourceX;
      const dy = targetY - sourceY;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const halfWidth = Math.max(0.05, edge.width / 2);
      const offsetX = -dy / distance * halfWidth;
      const offsetY = dx / distance * halfWidth;
      edgeOffset = addVertex(edgeData, edgeOffset, sourceX + offsetX, sourceY + offsetY, color, 1, input.viewport);
      edgeOffset = addVertex(edgeData, edgeOffset, sourceX - offsetX, sourceY - offsetY, color, 1, input.viewport);
      edgeOffset = addVertex(edgeData, edgeOffset, targetX + offsetX, targetY + offsetY, color, 1, input.viewport);
      edgeOffset = addVertex(edgeData, edgeOffset, targetX + offsetX, targetY + offsetY, color, 1, input.viewport);
      edgeOffset = addVertex(edgeData, edgeOffset, sourceX - offsetX, sourceY - offsetY, color, 1, input.viewport);
      edgeOffset = addVertex(edgeData, edgeOffset, targetX - offsetX, targetY - offsetY, color, 1, input.viewport);
    }
    this.edgeVertices = edgeData;
    this.drawVertices(edgeData, edgeOffset, gl.TRIANGLES, false);

    let haloData = ensureVertexCapacity(this.haloVertices, this.visibleNodes.length * 7);
    let haloOffset = 0;
    let nodeData = ensureVertexCapacity(this.nodeVertices, this.visibleNodes.length * 7);
    let nodeOffset = 0;
    for (const node of this.visibleNodes) {
      const point = input.positions[node.id];
      if (point === undefined) continue;
      const x = input.viewport.width / 2 + input.camera.x + point.x * input.camera.scale;
      const y = input.viewport.height / 2 + input.camera.y + point.y * input.camera.scale;
      const color = nodeColor(node, input);
      const opacity = neighborhood !== null && !neighborhood.has(node.id) ? 0.2 : 1;
      const nodeSize = graphNodeScreenRadius(node, input.camera.scale) * 2 * this.dpr;
      if (node.id === input.selectedId || node.id === input.focusedId || node.id === input.hoveredId) {
        haloOffset = addVertex(haloData, haloOffset, x, y, this.color(input.palette.focused, 0.2), nodeSize + 10 * this.dpr, input.viewport);
      }
      nodeOffset = addVertex(nodeData, nodeOffset, x, y, this.color(color, opacity), nodeSize, input.viewport);
    }
    this.haloVertices = haloData;
    this.nodeVertices = nodeData;
    this.drawVertices(haloData, haloOffset, gl.POINTS, true);
    this.drawVertices(nodeData, nodeOffset, gl.POINTS, true);
  }

  private drawVertices(data: Float32Array, length: number, mode: number, roundPoints: boolean): void {
    const gl = this.gl;
    const program = this.program;
    if (gl === null || program === null || this.vertexBuffer === null || length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const requiredBytes = length * Float32Array.BYTES_PER_ELEMENT;
    if (this.gpuBufferBytes < requiredBytes) {
      this.gpuBufferBytes = requiredBytes;
      gl.bufferData(gl.ARRAY_BUFFER, this.gpuBufferBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, length));
    const stride = 7 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(this.positionAttribute);
    gl.vertexAttribPointer(this.positionAttribute, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.colorAttribute);
    gl.vertexAttribPointer(this.colorAttribute, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(this.sizeAttribute);
    gl.vertexAttribPointer(this.sizeAttribute, 1, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT);
    gl.uniform1f(this.roundPointsUniform, roundPoints ? 1 : 0);
    gl.drawArrays(mode, 0, length / 7);
  }

  private drawCanvas2D(context: CanvasRenderingContext2D, input: GraphRenderInput): void {
    const dpr = this.dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, input.viewport.width, input.viewport.height);
    const neighborhood = this.hoverNeighborhood(input);
    for (const edge of this.visibleEdges) {
      const source = input.positions[edge.source];
      const target = input.positions[edge.target];
      if (source === undefined || target === undefined) continue;
      const start = graphPointToScreen(source, input.camera, input.viewport);
      const end = graphPointToScreen(target, input.camera, input.viewport);
      context.globalAlpha = neighborhood !== null && !neighborhood.has(edge.source) && !neighborhood.has(edge.target) ? 0.16 : 0.8;
      context.strokeStyle = edge.source === input.hoveredId || edge.target === input.hoveredId ? input.palette.focused : input.palette.line;
      context.lineWidth = edge.width;
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    }
    if (input.showArrows) for (const edge of this.visibleArrows) {
      const source = input.positions[edge.source];
      const target = input.positions[edge.target];
      if (source === undefined || target === undefined) continue;
      this.drawArrow(context, graphPointToScreen(source, input.camera, input.viewport), graphPointToScreen(target, input.camera, input.viewport), input.camera.scale, input.palette.line);
    }
    for (const node of this.visibleNodes) {
      const point = input.positions[node.id];
      if (point === undefined) continue;
      const screen = graphPointToScreen(point, input.camera, input.viewport);
      const radius = graphNodeScreenRadius(node, input.camera.scale);
      const opacity = neighborhood !== null && !neighborhood.has(node.id) ? 0.2 : 1;
      context.globalAlpha = opacity;
      if (node.id === input.selectedId || node.id === input.focusedId || node.id === input.hoveredId) {
        context.beginPath();
        context.arc(screen.x, screen.y, radius + 5, 0, Math.PI * 2);
        context.fillStyle = `${input.palette.focused}33`;
        context.fill();
      }
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fillStyle = nodeColor(node, input);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  private drawArrow(context: CanvasRenderingContext2D, start: GraphPoint, end: GraphPoint, scale: number, color: string): void {
    const alpha = Math.min(1, Math.max(0, 2 * (scale - 0.3)));
    if (alpha === 0) return;
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const size = 5;
    const x = start.x + (end.x - start.x) * 0.65;
    const y = start.y + (end.y - start.y) * 0.65;
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x + Math.cos(angle) * size, y + Math.sin(angle) * size);
    context.lineTo(x + Math.cos(angle + 2.6) * size, y + Math.sin(angle + 2.6) * size);
    context.lineTo(x + Math.cos(angle - 2.6) * size, y + Math.sin(angle - 2.6) * size);
    context.closePath();
    context.fill();
    context.globalAlpha = 1;
  }

  private drawOverlay(input: GraphRenderInput): void {
    const context = this.labelContext;
    const dpr = this.dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, input.viewport.width, input.viewport.height);
    const neighborhood = this.hoverNeighborhood(input);

    if (input.showArrows && this.mode === 'webgl') {
      for (const edge of this.visibleArrows) {
        const source = input.positions[edge.source];
        const target = input.positions[edge.target];
        if (source === undefined || target === undefined) continue;
        this.drawArrow(context, graphPointToScreen(source, input.camera, input.viewport), graphPointToScreen(target, input.camera, input.viewport), input.camera.scale, input.palette.line);
      }
    }

    const pinned = new Set([input.selectedId, input.focusedId, input.hoveredId].filter((id): id is string => id !== null));
    context.font = '12px system-ui, sans-serif';
    const labels = resolveGraphLabelIds(this.orderedVisibleNodes, input.positions, input.camera, input.viewport, input.labelMode, pinned, (text) => context.measureText(text).width, true);
    context.textBaseline = 'middle';
    for (const node of this.visibleNodes) {
      if (!labels.has(node.id)) continue;
      const point = input.positions[node.id];
      if (point === undefined) continue;
      const screen = graphPointToScreen(point, input.camera, input.viewport);
      context.globalAlpha = neighborhood !== null && !neighborhood.has(node.id) ? 0.2 : 1;
      context.fillStyle = input.palette.text;
      context.fillText(node.title, screen.x + graphNodeScreenRadius(node, input.camera.scale) + 7, screen.y);
    }
    context.globalAlpha = 1;
  }
}

export function compositeGraphSnapshot(canvases: readonly HTMLCanvasElement[]): string {
  const width = canvases.reduce((maximum, canvas) => Math.max(maximum, canvas.width), 0);
  const height = canvases.reduce((maximum, canvas) => Math.max(maximum, canvas.height), 0);
  const output = document.createElement('canvas');
  output.width = Math.max(1, width);
  output.height = Math.max(1, height);
  const context = output.getContext('2d');
  if (context === null) throw new Error('Canvas 2D is unavailable for graph screenshot');
  for (const canvas of canvases) if (!canvas.hidden) context.drawImage(canvas, 0, 0);
  return output.toDataURL('image/png');
}
