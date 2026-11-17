import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  Circle,
  Download,
  Grid3x3,
  ListOrdered,
  Loader2,
  MousePointer2,
  PenLine,
  Redo2,
  RotateCcw,
  Shrink,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "./toast";

export interface ImageEditorProps {
  src: string;
  name?: string;
  /** 由 /api/files/<id> 解析出的文件 ID；为空时只能下载 */
  fileId: string | null;
  /** 是否有权覆盖原图（学员仅自己的图片，辅导员可编辑全部） */
  canEdit: boolean;
  onClose: () => void;
  /** 保存成功后通知预览页刷新图片 */
  onSaved?: () => void;
}

type Tool = "select" | "arrow" | "rect" | "ellipse" | "pen" | "text" | "number" | "mosaic";
type Corner = "nw" | "ne" | "sw" | "se";

interface Point {
  x: number;
  y: number;
}

interface ShapeBase {
  id: string;
  color: string;
  stroke: number;
}

interface RectShape extends ShapeBase {
  kind: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ArrowShape extends ShapeBase {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 二次贝塞尔弯曲控制点；缺省时取起终点中点（即直线） */
  cx?: number;
  cy?: number;
}

interface PenShape extends ShapeBase {
  kind: "pen";
  points: Point[];
}

interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  size: number;
}

interface NumberShape extends ShapeBase {
  kind: "number";
  x: number;
  y: number;
  value: number;
  radius: number;
  target: Point | null;
}

interface MosaicShape extends ShapeBase {
  kind: "mosaic";
  x: number;
  y: number;
  w: number;
  h: number;
  strength: number;
}

type Annotation = RectShape | ArrowShape | PenShape | TextShape | NumberShape | MosaicShape;
type RectLike = RectShape | MosaicShape;

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TOOLS: { tool: Tool; label: string; icon: typeof MousePointer2 }[] = [
  { tool: "select", label: "选择 / 移动", icon: MousePointer2 },
  { tool: "arrow", label: "箭头", icon: ArrowUpRight },
  { tool: "rect", label: "矩形框选", icon: Square },
  { tool: "ellipse", label: "圆形框选", icon: Circle },
  { tool: "pen", label: "自由画笔", icon: PenLine },
  { tool: "text", label: "文字", icon: Type },
  { tool: "number", label: "序号", icon: ListOrdered },
  { tool: "mosaic", label: "马赛克", icon: Grid3x3 },
];

const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#111111"];

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRect(a: Point, b: Point): Bounds {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** 箭头的弯曲控制点：默认为起终点中点，拖动后变为曲线 */
function arrowControl(o: ArrowShape): Point {
  return o.cx === undefined || o.cy === undefined
    ? { x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 }
    : { x: o.cx, y: o.cy };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function boundsOf(o: Annotation): Bounds {
  switch (o.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
      return { x: o.x, y: o.y, w: o.w, h: o.h };
    case "arrow": {
      const cp = arrowControl(o);
      const xs = [o.x1, o.x2, cp.x];
      const ys = [o.y1, o.y2, cp.y];
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    case "pen": {
      const xs = o.points.map((p) => p.x);
      const ys = o.points.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    case "text": {
      const lines = o.text.split("\n");
      const width = Math.max(1, ...lines.map((line) => line.length)) * o.size * 0.62;
      return { x: o.x, y: o.y, w: width, h: Math.max(1, lines.length) * o.size * 1.25 };
    }
    case "number": {
      const b = { x: o.x - o.radius, y: o.y - o.radius, w: o.radius * 2, h: o.radius * 2 };
      if (o.target) {
        const minX = Math.min(b.x, o.target.x);
        const minY = Math.min(b.y, o.target.y);
        b.w = Math.max(b.x + b.w, o.target.x) - minX;
        b.h = Math.max(b.y + b.h, o.target.y) - minY;
        b.x = minX;
        b.y = minY;
      }
      return b;
    }
  }
}

function moveAnnotation(o: Annotation, dx: number, dy: number): Annotation {
  switch (o.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
      return { ...o, x: o.x + dx, y: o.y + dy };
    case "arrow":
      return {
        ...o,
        x1: o.x1 + dx,
        y1: o.y1 + dy,
        x2: o.x2 + dx,
        y2: o.y2 + dy,
        ...(o.cx !== undefined && o.cy !== undefined ? { cx: o.cx + dx, cy: o.cy + dy } : {}),
      };
    case "pen":
      return { ...o, points: o.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "text":
    case "number":
      return {
        ...o,
        x: o.x + dx,
        y: o.y + dy,
        ...(o.kind === "number" && o.target ? { target: { x: o.target.x + dx, y: o.target.y + dy } } : {}),
      } as Annotation;
  }
}

function resizeRect(o: RectLike, corner: Corner, p: Point): RectLike {
  const right = o.x + o.w;
  const bottom = o.y + o.h;
  let x = o.x;
  let y = o.y;
  let w = o.w;
  let h = o.h;
  if (corner === "nw") {
    x = Math.min(p.x, right);
    y = Math.min(p.y, bottom);
    w = Math.abs(right - p.x);
    h = Math.abs(bottom - p.y);
  } else if (corner === "ne") {
    x = Math.min(o.x, p.x);
    y = Math.min(p.y, bottom);
    w = Math.abs(p.x - o.x);
    h = Math.abs(bottom - p.y);
  } else if (corner === "sw") {
    x = Math.min(p.x, right);
    y = Math.min(o.y, p.y);
    w = Math.abs(right - p.x);
    h = Math.abs(p.y - o.y);
  } else {
    x = Math.min(o.x, p.x);
    y = Math.min(o.y, p.y);
    w = Math.abs(p.x - o.x);
    h = Math.abs(p.y - o.y);
  }
  return { ...o, x, y, w, h };
}

/** 根据背景色选择黑 / 白文字，避免白色序号在白色背景上不可见 */
function contrastText(color: string): string {
  const match = /^#?([a-f0-9]{6})$/i.exec(color.trim());
  if (!match) return "#ffffff";
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#ffffff";
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - Math.PI / 7) * size, to.y - Math.sin(angle - Math.PI / 7) * size);
  ctx.lineTo(to.x - Math.cos(angle + Math.PI / 7) * size, to.y - Math.sin(angle + Math.PI / 7) * size);
  ctx.closePath();
  ctx.fill();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, o: Annotation) {
  ctx.save();
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.stroke;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (o.kind === "rect" || o.kind === "ellipse") {
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    if (o.kind === "rect") ctx.rect(o.x, o.y, o.w, o.h);
    else ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.max(1, o.w / 2), Math.max(1, o.h / 2), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
  } else if (o.kind === "arrow") {
    const cp = arrowControl(o);
    const head = Math.max(o.stroke * 4, 14);
    ctx.beginPath();
    ctx.moveTo(o.x1, o.y1);
    ctx.quadraticCurveTo(cp.x, cp.y, o.x2, o.y2);
    ctx.stroke();
    drawArrowHead(ctx, cp, { x: o.x2, y: o.y2 }, head);
  } else if (o.kind === "pen") {
    if (o.points.length === 1) {
      ctx.beginPath();
      ctx.arc(o.points[0].x, o.points[0].y, Math.max(1, o.stroke / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (o.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(o.points[0].x, o.points[0].y);
      for (let i = 1; i < o.points.length; i += 1) ctx.lineTo(o.points[i].x, o.points[i].y);
      ctx.stroke();
    }
  } else if (o.kind === "text") {
    ctx.font = `600 ${o.size}px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lines = o.text.split("\n");
    lines.forEach((line, index) => ctx.fillText(line, o.x, o.y + index * o.size * 1.25));
  } else if (o.kind === "number") {
    if (o.target) {
      const angle = Math.atan2(o.target.y - o.y, o.target.x - o.x);
      const sx = o.x + Math.cos(angle) * o.radius;
      const sy = o.y + Math.sin(angle) * o.radius;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(o.target.x, o.target.y);
      ctx.stroke();
      drawArrowHead(ctx, { x: sx, y: sy }, o.target, Math.max(o.stroke * 4, 14));
    }
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = contrastText(o.color);
    ctx.font = `700 ${Math.round(o.radius * 1.08)}px system-ui, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(o.value), o.x, o.y + o.radius * 0.04);
  }
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, o: Annotation, screenScale: number) {
  const scale = screenScale > 0 ? screenScale : 1;
  const handle = 10 / scale;
  const b = boundsOf(o);
  ctx.save();
  ctx.setLineDash([6 / scale, 4 / scale]);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.6 / scale;
  ctx.strokeRect(b.x - 2 / scale, b.y - 2 / scale, b.w + 4 / scale, b.h + 4 / scale);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  const corners: Point[] = [];
  if (o.kind === "arrow") {
    corners.push({ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 });
  } else if (o.kind === "rect" || o.kind === "ellipse" || o.kind === "mosaic") {
    corners.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h });
  }
  for (const p of corners) {
    ctx.beginPath();
    ctx.rect(p.x - handle / 2, p.y - handle / 2, handle, handle);
    ctx.fill();
    ctx.stroke();
  }
  if (o.kind === "arrow") {
    // 中间弯曲控制点用圆形手柄区分，拖动即可把箭头弯成曲线
    const cp = arrowControl(o);
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, handle * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = "#38bdf8";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5 / scale;
    ctx.stroke();
  }
  ctx.restore();
}

function outputSpec(name: string | undefined): { mime: string; ext: string; white: boolean } {
  const ext = (name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "png") return { mime: "image/png", ext: "png", white: false };
  if (ext === "webp") return { mime: "image/webp", ext: "webp", white: false };
  if (ext === "jpg" || ext === "jpeg") return { mime: "image/jpeg", ext: "jpg", white: true };
  return { mime: "image/png", ext: "png", white: false };
}

function replaceExtension(name: string | undefined, ext: string): string {
  const base = (name ?? "image").replace(/\.[^.]+$/, "") || "image";
  return `${base}.${ext}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "操作失败，请稍后重试";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface MoveDrag {
  kind: "move";
  id: string;
  start: Point;
  origin: Annotation;
  moved: boolean;
}

interface ResizeDrag {
  kind: "resize";
  id: string;
  corner: Corner;
  origin: RectLike;
  moved: boolean;
}

interface EndDrag {
  kind: "end";
  id: string;
  which: "start" | "end" | "curve";
  origin: ArrowShape;
  moved: boolean;
}

interface DrawDrag {
  kind: "draw";
  tool: Tool;
  start: Point;
  current: Point;
  moved: boolean;
  numberValue: number;
}

interface PenDrag {
  kind: "pen";
  points: Point[];
}

interface PanDrag {
  kind: "pan";
  startX: number;
  startY: number;
  panX: number;
  panY: number;
}

type DragState = MoveDrag | ResizeDrag | EndDrag | DrawDrag | PenDrag | PanDrag;

interface InlineEdit {
  mode: "text" | "number";
  x: number;
  y: number;
  value: string;
  objId: string | null;
}

interface CompressPreview {
  blob: Blob;
  width: number;
  height: number;
}

/** 马赛克缩略图复用的离屏画布，避免拖动时反复创建 */
let mosaicScratch: HTMLCanvasElement | null = null;

/** 用像素化（马赛克方块）覆盖选区，比高斯模糊更直观 */
function drawMosaicLayer(
  ctx: CanvasRenderingContext2D,
  o: MosaicShape,
  img: HTMLImageElement,
  natural: { w: number; h: number },
) {
  const x = Math.max(0, o.x);
  const y = Math.max(0, o.y);
  const w = Math.min(natural.w - x, o.w);
  const h = Math.min(natural.h - y, o.h);
  if (w < 1 || h < 1) return;

  const block = Math.max(4, o.strength);
  const sw = Math.max(1, Math.round(w / block));
  const sh = Math.max(1, Math.round(h / block));
  if (!mosaicScratch) mosaicScratch = document.createElement("canvas");
  const scratch = mosaicScratch;
  scratch.width = sw;
  scratch.height = sh;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.clearRect(0, 0, sw, sh);
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(img, x, y, w, h, 0, 0, sw, sh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, sw, sh, x, y, w, h);
  ctx.restore();
}

export function ImageEditor({ src, name, fileId, canEdit, onClose, onSaved }: ImageEditorProps) {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const naturalRef = useRef<{ w: number; h: number } | null>(null);
  const objectsRef = useRef<Annotation[]>([]);
  const selectedRef = useRef<Annotation | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const beforeRef = useRef<Annotation[] | null>(null);
  const pastRef = useRef<Annotation[][]>([]);
  const futureRef = useRef<Annotation[][]>([]);
  const defaultsRef = useRef(false);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [objects, setObjects] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [color, setColor] = useState("#ff3b30");
  const [stroke, setStroke] = useState(6);
  const [fontSize, setFontSize] = useState(40);
  const [numberRadius, setNumberRadius] = useState(28);
  const [numberArrow, setNumberArrow] = useState(false);
  const [mosaicStrength, setMosaicStrength] = useState(14);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState<"save" | "compress" | "replace" | null>(null);
  const [compressOpen, setCompressOpen] = useState(false);
  const [quality, setQuality] = useState(0.85);
  const [maxEdge, setMaxEdge] = useState(0);
  const [preview, setPreview] = useState<CompressPreview | null>(null);
  const [, setHistoryTick] = useState(0);

  objectsRef.current = objects;
  draftRef.current = draft;
  selectedRef.current = objects.find((o) => o.id === selectedId) ?? null;

  const screenScale = useCallback((): number => {
    const canvas = canvasRef.current;
    const nat = naturalRef.current;
    if (!canvas || !nat) return 1;
    const width = canvas.getBoundingClientRect().width;
    return width > 0 ? width / nat.w : 1;
  }, []);

  const pushHistory = useCallback((snapshot?: Annotation[]) => {
    pastRef.current.push((snapshot ?? objectsRef.current).map((o) => ({ ...o })));
    if (pastRef.current.length > 60) pastRef.current.shift();
    futureRef.current = [];
    setHistoryTick((tick) => tick + 1);
  }, []);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.push(objectsRef.current);
    setObjects(previous);
    setSelectedId(null);
    setHistoryTick((tick) => tick + 1);
  }, []);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(objectsRef.current);
    setObjects(next);
    setSelectedId(null);
    setHistoryTick((tick) => tick + 1);
  }, []);

  const addAnnotation = useCallback((annotation: Annotation) => {
    pushHistory();
    setObjects((prev) => [...prev, annotation]);
    setSelectedId(null);
  }, [pushHistory]);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    pushHistory();
    setObjects((prev) => prev.filter((o) => o.id !== selectedId));
    setSelectedId(null);
  }, [pushHistory, selectedId]);

  /* 加载图片 */
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setLoadError(null);
    setNatural(null);
    naturalRef.current = null;
    imgRef.current = null;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (!img.naturalWidth || !img.naturalHeight) {
        setLoadError("图片尺寸无效");
        return;
      }
      imgRef.current = img;
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      naturalRef.current = size;
      setNatural(size);
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) setLoadError("图片加载失败");
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  /* 根据图片尺寸初始化画笔 / 字号 / 序号大小 */
  useEffect(() => {
    if (!natural || defaultsRef.current) return;
    defaultsRef.current = true;
    const base = Math.min(natural.w, natural.h);
    setStroke(Math.max(3, Math.round(base * 0.004)));
    setFontSize(Math.max(20, Math.round(base * 0.05)));
    setNumberRadius(Math.max(16, Math.round(base * 0.032)));
    setMosaicStrength(Math.max(10, Math.round(base * 0.015)));
  }, [natural]);

  const paintBase = useCallback((ctx: CanvasRenderingContext2D, scale: number, white: boolean) => {
    const img = imgRef.current;
    const nat = naturalRef.current;
    if (!img || !nat) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (white) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, nat.w, nat.h);
    }
    ctx.drawImage(img, 0, 0, nat.w, nat.h);
    const list = objectsRef.current;
    for (const o of list) {
      if (o.kind === "mosaic") drawMosaicLayer(ctx, o, img, nat);
    }
    for (const o of list) {
      if (o.kind !== "mosaic") drawAnnotation(ctx, o);
    }
  }, []);

  /* 重绘画布 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const nat = naturalRef.current;
    if (!canvas || !nat || !ready) return;
    if (canvas.width !== nat.w) canvas.width = nat.w;
    if (canvas.height !== nat.h) canvas.height = nat.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, nat.w, nat.h);
    paintBase(ctx, 1, false);
    const draftObj = draftRef.current;
    const img = imgRef.current;
    if (draftObj && img) {
      if (draftObj.kind === "mosaic") {
        drawMosaicLayer(ctx, draftObj, img, nat);
        // 选框提示：半透明高亮 + 虚线边框，拖动时清晰可见
        ctx.save();
        ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
        ctx.fillRect(draftObj.x, draftObj.y, draftObj.w, draftObj.h);
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2 / screenScale();
        ctx.setLineDash([8 / screenScale(), 5 / screenScale()]);
        ctx.strokeRect(draftObj.x, draftObj.y, draftObj.w, draftObj.h);
        ctx.restore();
      } else {
        drawAnnotation(ctx, draftObj);
      }
    }
    if (selectedRef.current) drawSelection(ctx, selectedRef.current, screenScale());
  }, [natural, objects, draft, selectedId, zoom, ready, paintBase, screenScale]);

  const toNatural = useCallback((clientX: number, clientY: number): Point | null => {
    const canvas = canvasRef.current;
    const nat = naturalRef.current;
    if (!canvas || !nat) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * nat.w,
      y: ((clientY - rect.top) / rect.height) * nat.h,
    };
  }, []);

  const nextNumber = useCallback((): number => {
    return objectsRef.current.reduce((max, o) => (o.kind === "number" ? Math.max(max, o.value) : max), 0) + 1;
  }, []);

  const makeDraftPreview = useCallback((
    draftTool: Tool,
    start: Point,
    current: Point,
    numberValue: number,
    moved: boolean,
  ): Annotation | null => {
    const id = "draft";
    if (draftTool === "arrow") {
      return { kind: "arrow", id, color, stroke, x1: start.x, y1: start.y, x2: current.x, y2: current.y };
    }
    if (draftTool === "rect" || draftTool === "ellipse") {
      return { kind: draftTool, id, color, stroke, ...normalizeRect(start, current) };
    }
    if (draftTool === "mosaic") {
      return { kind: "mosaic", id, color, stroke: 0, ...normalizeRect(start, current), strength: mosaicStrength };
    }
    if (draftTool === "number") {
      return {
        kind: "number",
        id,
        color,
        stroke,
        x: start.x,
        y: start.y,
        value: numberValue,
        radius: numberRadius,
        target: moved ? current : null,
      };
    }
    return null;
  }, [color, mosaicStrength, numberRadius, stroke]);

  const hitObject = useCallback((p: Point, tolerance: number): Annotation | null => {
    const list = objectsRef.current;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const o = list[i];
      if (o.kind === "arrow") {
        if (distanceToSegment(p, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }) <= tolerance + o.stroke) return o;
        continue;
      }
      if (o.kind === "pen") {
        if (o.points.length === 1 && Math.hypot(p.x - o.points[0].x, p.y - o.points[0].y) <= tolerance + o.stroke) return o;
        for (let k = 1; k < o.points.length; k += 1) {
          if (distanceToSegment(p, o.points[k - 1], o.points[k]) <= tolerance + o.stroke) return o;
        }
        continue;
      }
      const b = boundsOf(o);
      if (p.x >= b.x - tolerance && p.x <= b.x + b.w + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.h + tolerance) return o;
    }
    return null;
  }, []);

  const hitHandle = useCallback((o: Annotation, p: Point, tolerance: number): Corner | "start" | "end" | "curve" | null => {
    const b = boundsOf(o);
    if (o.kind === "arrow") {
      if (Math.hypot(p.x - o.x1, p.y - o.y1) <= tolerance) return "start";
      if (Math.hypot(p.x - o.x2, p.y - o.y2) <= tolerance) return "end";
      const cp = arrowControl(o);
      if (Math.hypot(p.x - cp.x, p.y - cp.y) <= tolerance) return "curve";
      return null;
    }
    if (o.kind === "rect" || o.kind === "ellipse" || o.kind === "mosaic") {
      const corners: [Corner, Point][] = [
        ["nw", { x: b.x, y: b.y }],
        ["ne", { x: b.x + b.w, y: b.y }],
        ["sw", { x: b.x, y: b.y + b.h }],
        ["se", { x: b.x + b.w, y: b.y + b.h }],
      ];
      for (const [corner, point] of corners) {
        if (Math.abs(p.x - point.x) <= tolerance && Math.abs(p.y - point.y) <= tolerance) return corner;
      }
    }
    return null;
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || busy) return;
    if (e.button === 1 || e.altKey) {
      e.preventDefault();
      dragRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const p = toNatural(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const tolerance = 10 / screenScale();

    if (tool === "select") {
      const selected = selectedRef.current;
      if (selected) {
        const handle = hitHandle(selected, p, tolerance);
        if (handle) {
          beforeRef.current = objectsRef.current.map((o) => ({ ...o }));
          if (selected.kind === "arrow" && (handle === "start" || handle === "end" || handle === "curve")) {
            dragRef.current = { kind: "end", id: selected.id, which: handle, origin: selected, moved: false };
          } else if (selected.kind === "rect" || selected.kind === "ellipse" || selected.kind === "mosaic") {
            dragRef.current = { kind: "resize", id: selected.id, corner: handle as Corner, origin: selected, moved: false };
          }
          return;
        }
      }
      const hit = hitObject(p, tolerance);
      if (hit) {
        beforeRef.current = objectsRef.current.map((o) => ({ ...o }));
        setSelectedId(hit.id);
        dragRef.current = { kind: "move", id: hit.id, start: p, origin: hit, moved: false };
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (tool === "text") {
      setInlineEdit({ mode: "text", x: p.x, y: p.y, value: "", objId: null });
      return;
    }
    if (tool === "number" && !numberArrow) {
      setInlineEdit({ mode: "number", x: p.x, y: p.y, value: String(nextNumber()), objId: null });
      return;
    }
    if (tool === "pen") {
      dragRef.current = { kind: "pen", points: [p] };
      setDraft({ kind: "pen", id: "draft", color, stroke, points: [p] });
      return;
    }

    const numberValue = nextNumber();
    dragRef.current = { kind: "draw", tool, start: p, current: p, moved: false, numberValue };
    setDraft(makeDraftPreview(tool, p, p, numberValue, false));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      setPan({ x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) });
      return;
    }
    const p = toNatural(e.clientX, e.clientY);
    if (!p) return;

    if (drag.kind === "pen") {
      const last = drag.points[drag.points.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 1.2 / screenScale()) drag.points.push(p);
      setDraft({ kind: "pen", id: "draft", color, stroke, points: drag.points.slice() });
      return;
    }
    if (drag.kind === "draw") {
      drag.current = p;
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 2) drag.moved = true;
      setDraft(makeDraftPreview(drag.tool, drag.start, p, drag.numberValue, drag.moved));
      return;
    }
    if (drag.kind === "move") {
      drag.moved = true;
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      setObjects((prev) => prev.map((o) => (o.id === drag.id ? moveAnnotation(drag.origin, dx, dy) : o)));
      return;
    }
    if (drag.kind === "resize") {
      drag.moved = true;
      setObjects((prev) => prev.map((o) => (o.id === drag.id ? resizeRect(drag.origin, drag.corner, p) : o)));
      return;
    }
    if (drag.kind === "end") {
      drag.moved = true;
      setObjects((prev) =>
        prev.map((o) => {
          if (o.id !== drag.id || o.kind !== "arrow") return o;
          if (drag.which === "curve") return { ...o, cx: p.x, cy: p.y };
          return drag.which === "start" ? { ...o, x1: p.x, y1: p.y } : { ...o, x2: p.x, y2: p.y };
        }),
      );
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已释放
    }
    if (drag.kind === "pan") return;

    if (drag.kind === "pen") {
      setDraft(null);
      if (drag.points.length > 1) {
        addAnnotation({ kind: "pen", id: uid(), color, stroke, points: drag.points });
      }
      return;
    }
    if (drag.kind === "draw") {
      setDraft(null);
      const { tool: drawTool, start, current, moved } = drag;
      if (drawTool === "rect" || drawTool === "ellipse") {
        const r = normalizeRect(start, current);
        if (r.w > 3 && r.h > 3) addAnnotation({ kind: drawTool, id: uid(), color, stroke, ...r });
      } else if (drawTool === "arrow") {
        if (Math.hypot(current.x - start.x, current.y - start.y) > 4) {
          addAnnotation({ kind: "arrow", id: uid(), color, stroke, x1: start.x, y1: start.y, x2: current.x, y2: current.y });
        }
      } else if (drawTool === "mosaic") {
        const r = normalizeRect(start, current);
        if (r.w > 4 && r.h > 4) {
          addAnnotation({ kind: "mosaic", id: uid(), color, stroke: 0, ...r, strength: mosaicStrength });
        }
      } else if (drawTool === "number") {
        addAnnotation({
          kind: "number",
          id: uid(),
          color,
          stroke,
          x: start.x,
          y: start.y,
          value: drag.numberValue,
          radius: numberRadius,
          target: moved ? current : null,
        });
      }
      return;
    }
    if (drag.moved) pushHistory(beforeRef.current ?? undefined);
    beforeRef.current = null;
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (tool !== "select" || !ready) return;
    const p = toNatural(e.clientX, e.clientY);
    if (!p) return;
    const hit = hitObject(p, 10 / screenScale());
    if (hit?.kind === "text") {
      setSelectedId(hit.id);
      setInlineEdit({ mode: "text", x: hit.x, y: hit.y, value: hit.text, objId: hit.id });
    } else if (hit?.kind === "number") {
      setSelectedId(hit.id);
      setInlineEdit({ mode: "number", x: hit.x, y: hit.y, value: String(hit.value), objId: hit.id });
    }
  };

  const confirmInline = useCallback(() => {
    if (!inlineEdit) return;
    const raw = inlineEdit.value.trim();
    if (!raw) {
      setInlineEdit(null);
      return;
    }
    if (inlineEdit.mode === "text") {
      if (inlineEdit.objId) {
        pushHistory();
        setObjects((prev) => prev.map((o) => (o.id === inlineEdit.objId && o.kind === "text" ? { ...o, text: raw } : o)));
      } else {
        addAnnotation({
          kind: "text",
          id: uid(),
          color,
          stroke,
          x: inlineEdit.x,
          y: inlineEdit.y,
          text: raw,
          size: fontSize,
        });
      }
    } else {
      const value = clamp(Math.round(Number(raw) || 1), 1, 9999);
      if (inlineEdit.objId) {
        pushHistory();
        setObjects((prev) => prev.map((o) => (o.id === inlineEdit.objId && o.kind === "number" ? { ...o, value } : o)));
      } else {
        addAnnotation({
          kind: "number",
          id: uid(),
          color,
          stroke,
          x: inlineEdit.x,
          y: inlineEdit.y,
          value,
          radius: numberRadius,
          target: null,
        });
      }
    }
    setInlineEdit(null);
  }, [addAnnotation, color, fontSize, inlineEdit, numberRadius, pushHistory, stroke]);

  /* 导出当前编辑结果为 Blob */
  const buildExport = useCallback(async (opts: {
    maxEdge?: number;
    mime: string;
    quality?: number;
    white: boolean;
  }): Promise<CompressPreview> => {
    const img = imgRef.current;
    const nat = naturalRef.current;
    if (!img || !nat) throw new Error("图片尚未加载完成");
    let width = nat.w;
    let height = nat.h;
    if (opts.maxEdge && Math.max(width, height) > opts.maxEdge) {
      const ratio = opts.maxEdge / Math.max(width, height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    paintBase(ctx, width / nat.w, opts.white);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("图片编码失败"))), opts.mime, opts.quality);
    });
    return { blob, width, height };
  }, [paintBase]);

  const saveToServer = useCallback(async (blob: Blob, filename: string, message: string) => {
    if (!fileId || !canEdit) throw new Error("没有保存权限");
    const form = new FormData();
    form.append("file", new File([blob], filename, { type: blob.type || "image/jpeg" }));
    form.append("name", filename);
    await api.replace(`/api/files/${fileId}`, form);
    toast(message, "success");
    onSaved?.();
  }, [canEdit, fileId, onSaved, toast]);

  const handleSave = async () => {
    if (busy || !ready) return;
    const spec = outputSpec(name);
    if (!canEdit || !fileId) {
      await handleDownload();
      return;
    }
    setBusy("save");
    try {
      const { blob } = await buildExport({ mime: spec.mime, quality: spec.mime === "image/png" ? undefined : 0.92, white: spec.white });
      await saveToServer(blob, replaceExtension(name, spec.ext), "图片已保存");
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async () => {
    if (busy || !ready) return;
    setBusy("save");
    try {
      const spec = outputSpec(name);
      const { blob } = await buildExport({ mime: spec.mime, quality: spec.mime === "image/png" ? undefined : 0.92, white: spec.white });
      downloadBlob(blob, replaceExtension(`${name ?? "image"}`.replace(/\.[^.]+$/, "") + "-edited", spec.ext));
      toast("图片已下载", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const replaceCompressed = async () => {
    if (!preview || busy) return;
    setBusy("replace");
    try {
      await saveToServer(preview.blob, replaceExtension(name, "jpg"), "压缩图片已替换原图");
      setCompressOpen(false);
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const downloadCompressed = () => {
    if (!preview) return;
    downloadBlob(preview.blob, replaceExtension(name, "jpg"));
  };

  /* 压缩预览：选项变化时重新生成 JPEG */
  useEffect(() => {
    if (!compressOpen || !ready) return;
    let cancelled = false;
    setPreview(null);
    const timer = setTimeout(() => {
      void buildExport({ maxEdge: maxEdge || undefined, mime: "image/jpeg", quality, white: true })
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch((err) => {
          if (!cancelled) toast(errorMessage(err), "error");
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [compressOpen, ready, maxEdge, quality, buildExport, toast]);

  /* 滚轮缩放 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clamp(z * Math.exp(-e.deltaY * 0.0015), 0.5, 8));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [ready]);

  /* 快捷键：Esc 退出 / Ctrl+Z 撤销 / Delete 删除选中 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (inlineEdit) setInlineEdit(null);
        else if (dragRef.current) {
          dragRef.current = null;
          setDraft(null);
        } else onClose();
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inlineEdit, onClose, redo, removeSelected, selectedId, undo]);

  /* 切换图片时复位视图 */
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setObjects([]);
    setSelectedId(null);
    setInlineEdit(null);
    pastRef.current = [];
    futureRef.current = [];
    setHistoryTick((tick) => tick + 1);
  }, [src]);

  const inlineStyle = (): CSSProperties | null => {
    const canvas = canvasRef.current;
    const nat = naturalRef.current;
    if (!canvas || !nat || !inlineEdit) return null;
    const rect = canvas.getBoundingClientRect();
    const rawLeft = rect.left + (inlineEdit.x / nat.w) * rect.width;
    const rawTop = rect.top + (inlineEdit.y / nat.h) * rect.height;
    const size = inlineEdit.mode === "text"
      ? clamp(fontSize * (rect.width / nat.w), 14, 40)
      : clamp(numberRadius * 1.1 * (rect.width / nat.w), 13, 28);
    return {
      position: "fixed",
      left: clamp(rawLeft, 8, Math.max(8, window.innerWidth - 220)),
      top: clamp(rawTop, 56, Math.max(56, window.innerHeight - 80)),
      fontSize: size,
      transform: inlineEdit.mode === "number" ? "translate(-50%, -50%)" : undefined,
    };
  };

  const inlinePosition = inlineStyle();
  const actionClass = "flex h-8 items-center justify-center gap-1 rounded-lg px-2 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-40";
  const toolClass = (active: boolean) =>
    cn(
      "flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-xs transition-colors",
      active ? "bg-sky-500 text-white shadow" : "text-white/75 hover:bg-white/10 hover:text-white",
    );
  const cursor =
    tool === "select" ? "default" : tool === "text" ? "text" : tool === "number" && !numberArrow ? "copy" : "crosshair";
  const hint =
    tool === "select"
      ? "拖动对象移动，拖角缩放；选中箭头后拖动中间圆点可弯曲；双击文字 / 序号可修改；Ctrl+Z 撤销"
      : tool === "text"
        ? "点击图片输入文字，Shift+Enter 或 Ctrl+Enter 确认"
        : tool === "number"
          ? numberArrow
            ? "从序号位置拖向标注目标，绘制「序号 + 箭头」"
            : "点击图片放置序号，方向键可微调数字"
          : tool === "mosaic"
            ? "拖动框选需要打码的区域，虚线框内为马赛克预览"
            : tool === "pen"
              ? "按住拖动自由绘制"
              : tool === "arrow"
                ? "拖动绘制箭头；画好后用「选择」工具拖动箭头中间圆点即可弯曲"
                : "在图片上拖动绘制";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片编辑"
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950/95 text-white"
    >
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-white/10 bg-black/40 px-2 py-1.5">
        <button type="button" onClick={onClose} className={actionClass} title="退出编辑" aria-label="退出编辑">
          <X className="size-4" />
          <span className="hidden sm:inline">退出</span>
        </button>
        <span className="hidden max-w-44 truncate text-xs text-white/45 lg:block">{name}</span>

        <div className="flex flex-1 flex-wrap items-center justify-center gap-0.5">
          {TOOLS.map(({ tool: value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={tool === value}
              onClick={() => {
                setTool(value);
                setInlineEdit(null);
                if (value !== "select") setSelectedId(null);
              }}
              className={toolClass(tool === value)}
            >
              <Icon className="size-4" />
            </button>
          ))}

          <span className="mx-1 h-6 w-px bg-white/15" />

          <div className="flex items-center gap-1 px-1">
            {COLORS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setColor(value)}
                aria-label={`颜色 ${value}`}
                title={value}
                className={cn(
                  "size-5 rounded-full border transition-transform hover:scale-110",
                  color === value ? "border-white ring-2 ring-sky-400" : "border-white/30",
                )}
                style={{ backgroundColor: value }}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="自定义颜色"
              title="自定义颜色"
              className="h-6 w-7 cursor-pointer rounded border border-white/20 bg-transparent p-0"
            />
          </div>

          <span className="mx-1 h-6 w-px bg-white/15" />

          <label className="flex items-center gap-1 px-1 text-[11px] text-white/60" title="线条粗细">
            线宽
            <input
              type="range"
              min={1}
              max={30}
              value={stroke}
              onChange={(e) => setStroke(Number(e.target.value))}
              className="w-16 accent-sky-400"
            />
          </label>

          {tool === "text" && (
            <label className="flex items-center gap-1 px-1 text-[11px] text-white/60" title="文字大小">
              字号
              <input
                type="range"
                min={10}
                max={200}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-16 accent-sky-400"
              />
            </label>
          )}

          {tool === "number" && (
            <>
              <label className="flex items-center gap-1 px-1 text-[11px] text-white/60" title="序号圆圈大小">
                大小
                <input
                  type="range"
                  min={10}
                  max={160}
                  value={numberRadius}
                  onChange={(e) => setNumberRadius(Number(e.target.value))}
                  className="w-16 accent-sky-400"
                />
              </label>
              <button
                type="button"
                onClick={() => setNumberArrow((value) => !value)}
                aria-pressed={numberArrow}
                title="序号带箭头"
                className={toolClass(numberArrow)}
              >
                <ArrowUpRight className="size-4" />
              </button>
            </>
          )}

          {tool === "mosaic" && (
            <label className="flex items-center gap-1 px-1 text-[11px] text-white/60" title="马赛克方块大小">
              块大小
              <input
                type="range"
                min={4}
                max={120}
                value={mosaicStrength}
                onChange={(e) => setMosaicStrength(Number(e.target.value))}
                className="w-16 accent-sky-400"
              />
            </label>
          )}

          <span className="mx-1 h-6 w-px bg-white/15" />

          <button
            type="button"
            onClick={undo}
            disabled={pastRef.current.length === 0}
            className={actionClass}
            title="撤销 (Ctrl+Z)"
            aria-label="撤销"
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={futureRef.current.length === 0}
            className={actionClass}
            title="重做 (Ctrl+Shift+Z)"
            aria-label="重做"
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={removeSelected}
            disabled={!selectedId}
            className={actionClass}
            title="删除选中标注 (Delete)"
            aria-label="删除选中标注"
          >
            <Trash2 className="size-4" />
          </button>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setZoom((z) => clamp(z / 1.25, 0.5, 8))}
            className={actionClass}
            title="缩小"
            aria-label="缩小"
          >
            <ZoomOut className="size-4" />
          </button>
          <span className="w-11 text-center text-[11px] tabular-nums text-white/60">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom((z) => clamp(z * 1.25, 0.5, 8))}
            className={actionClass}
            title="放大"
            aria-label="放大"
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className={actionClass}
            title="适应窗口"
            aria-label="适应窗口"
          >
            <RotateCcw className="size-4" />
          </button>
          <span className="mx-1 h-6 w-px bg-white/15" />
          <button type="button" onClick={handleDownload} disabled={!ready || !!busy} className={actionClass} title="下载图片">
            <Download className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setInlineEdit(null);
              setCompressOpen(true);
            }}
            disabled={!ready || !!busy}
            className={actionClass}
            title="压缩图片"
          >
            <Shrink className="size-4" />
            <span className="hidden sm:inline">压缩</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!ready || !!busy}
            className="flex h-8 items-center justify-center gap-1 rounded-lg bg-sky-500 px-3 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:pointer-events-none disabled:opacity-40"
            title={canEdit && fileId ? "保存并覆盖原图" : "下载图片"}
          >
            <Check className="size-4" />
            {canEdit && fileId ? "保存" : "下载"}
          </button>
        </div>
      </div>

      {/* 画布区域 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full w-full items-center justify-center p-2 sm:p-4">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            className={cn(
              "max-h-full max-w-full touch-none select-none rounded shadow-2xl",
              !ready && "invisible",
            )}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center center", cursor }}
          />
        </div>

        {!ready && !loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/70">
            <Loader2 className="size-6 animate-spin" />
            正在加载图片…
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/70">
            <span>{loadError}</span>
            <button type="button" onClick={onClose} className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/20">
              关闭
            </button>
          </div>
        )}

        {inlineEdit && inlinePosition && (
          <div
            className="z-10 flex items-start gap-1 rounded-lg border border-sky-400 bg-neutral-900/95 p-1 shadow-xl"
            style={inlinePosition}
          >
            {inlineEdit.mode === "text" ? (
              <textarea
                autoFocus
                rows={2}
                value={inlineEdit.value}
                onChange={(e) => setInlineEdit((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setInlineEdit(null);
                  } else if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    confirmInline();
                  }
                }}
                placeholder="输入文字…"
                aria-label="文字内容"
                className="min-w-40 resize-none bg-transparent px-1 py-0.5 leading-tight text-white outline-none placeholder:text-white/40"
                style={{ fontSize: "inherit" }}
              />
            ) : (
              <input
                autoFocus
                type="number"
                min={1}
                max={9999}
                value={inlineEdit.value}
                onChange={(e) => setInlineEdit((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setInlineEdit(null);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    confirmInline();
                  }
                }}
                aria-label="序号"
                className="w-16 bg-transparent px-1 py-0.5 text-white outline-none"
                style={{ fontSize: "inherit" }}
              />
            )}
            <button
              type="button"
              onClick={confirmInline}
              className="mt-0.5 flex size-6 items-center justify-center rounded bg-sky-500 text-white hover:bg-sky-400"
              title="确认"
              aria-label="确认"
            >
              <Check className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setInlineEdit(null)}
              className="mt-0.5 flex size-6 items-center justify-center rounded bg-white/10 text-white hover:bg-white/20"
              title="取消"
              aria-label="取消"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        <div className="pointer-events-none absolute bottom-2 left-1/2 max-w-[92vw] -translate-x-1/2 truncate rounded-full bg-black/60 px-3 py-1 text-[11px] text-white/60">
          {hint}
        </div>
      </div>

      {/* 压缩面板 */}
      {compressOpen && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4"
          onClick={() => !busy && setCompressOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Shrink className="size-4" />
                压缩图片
              </h3>
              <button
                type="button"
                onClick={() => setCompressOpen(false)}
                className="flex size-7 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white"
                aria-label="关闭压缩面板"
              >
                <X className="size-4" />
              </button>
            </div>

            <label className="mb-3 block text-xs text-white/60">
              画质 {Math.round(quality * 100)}%
              <input
                type="range"
                min={0.5}
                max={0.95}
                step={0.05}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="mt-1 w-full accent-sky-400"
              />
            </label>

            <label className="mb-3 block text-xs text-white/60">
              最长边
              <select
                value={maxEdge}
                onChange={(e) => setMaxEdge(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-white/15 bg-neutral-800 px-2 py-1.5 text-sm text-white outline-none focus:border-sky-400"
              >
                <option value={0}>保持原始尺寸</option>
                <option value={3840}>3840 px（4K）</option>
                <option value={2560}>2560 px</option>
                <option value={1920}>1920 px</option>
                <option value={1280}>1280 px</option>
                <option value={800}>800 px</option>
              </select>
            </label>

            <div className="mb-4 rounded-lg bg-black/40 px-3 py-2 text-xs text-white/70">
              {preview ? (
                <>
                  输出 {preview.width} × {preview.height}，约 {formatSize(preview.blob.size)}
                </>
              ) : (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  正在生成预览…
                </span>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={downloadCompressed}
                disabled={!preview || !!busy}
                className={actionClass}
              >
                <Download className="size-4" />
                下载
              </button>
              {canEdit && fileId && (
                <button
                  type="button"
                  onClick={replaceCompressed}
                  disabled={!preview || !!busy}
                  className="flex h-8 items-center justify-center gap-1 rounded-lg bg-sky-500 px-3 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:pointer-events-none disabled:opacity-40"
                >
                  <Check className="size-4" />
                  替换原图
                </button>
              )}
            </div>
            {!canEdit && (
              <p className="mt-3 text-[11px] leading-relaxed text-white/40">
                当前账号只能下载处理后的图片，无法覆盖原图。
              </p>
            )}
          </div>
        </div>
      )}

      {busy && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-black/50 text-sm text-white/80">
          <Loader2 className="size-6 animate-spin" />
          {busy === "replace" ? "正在替换原图…" : busy === "compress" ? "正在压缩…" : "正在保存…"}
        </div>
      )}
    </div>
  );
}
