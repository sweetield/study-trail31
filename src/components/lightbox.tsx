import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, PenLine, X } from "lucide-react";
import { api } from "@/lib/api";
import { ImageEditor } from "./image-editor";

export interface LightboxImage {
  src: string;
  name?: string;
}

interface LightboxContextValue {
  open: (images: LightboxImage[], index?: number) => void;
}

interface FilePermission {
  can_edit?: boolean;
  reason?: string | null;
}

interface PermissionState {
  loading: boolean;
  canEdit: boolean;
  reason: string | null;
}

const FILE_URL = /\/api\/files\/([a-f0-9]{32})(?:[?#]|$)/;

/** 从 /api/files/<32 位 ID> 形式的图片地址中解析文件 ID */
export function fileIdFromSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.match(FILE_URL)?.[1] ?? null;
}

function versionedSrc(src: string, version: number | undefined): string {
  if (!version) return src;
  return `${src}${src.includes("?") ? "&" : "?"}v=${version}`;
}

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [images, setImages] = useState<LightboxImage[]>([]);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [permissions, setPermissions] = useState<Record<string, PermissionState>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);

  const open = useCallback((next: LightboxImage[], start = 0) => {
    const list = next.filter((image) => !!image?.src);
    if (!list.length) return;
    setImages(list);
    setIndex(Math.max(0, Math.min(start, list.length - 1)));
  }, []);

  const close = useCallback(() => {
    setEditing(false);
    setImages([]);
  }, []);
  const previous = useCallback(() => setIndex((i) => (i - 1 + images.length) % images.length), [images.length]);
  const next = useCallback(() => setIndex((i) => (i + 1) % images.length), [images.length]);

  const current = images[index];
  const fileId = fileIdFromSrc(current?.src);
  const permission = fileId ? permissions[fileId] : undefined;
  const canEdit = !!permission?.canEdit;
  const src = current ? versionedSrc(current.src, fileId ? versions[fileId] : undefined) : "";

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (images.length && !el.open) el.showModal();
    if (!images.length && el.open) el.close();
  }, [images.length]);

  useEffect(() => {
    if (!images.length) return;
    function onKey(e: KeyboardEvent) {
      if (editing) return;
      if (e.key === "ArrowLeft" && images.length > 1) previous();
      else if (e.key === "ArrowRight" && images.length > 1) next();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [images.length, previous, next, editing]);

  /* 查询当前图片的编辑权限：学员仅自己上传的图片，辅导员可编辑全部 */
  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    setPermissions((prev) => ({ ...prev, [fileId]: { loading: true, canEdit: false, reason: null } }));
    api
      .get<{ permission?: FilePermission }>(`/api/files/${fileId}/meta`)
      .then((data) => {
        if (cancelled) return;
        setPermissions((prev) => ({
          ...prev,
          [fileId]: {
            loading: false,
            canEdit: !!data.permission?.can_edit,
            reason: data.permission?.reason ?? null,
          },
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPermissions((prev) => ({
          ...prev,
          [fileId]: {
            loading: false,
            canEdit: false,
            reason: err instanceof Error ? err.message : "无法获取编辑权限",
          },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const value = useMemo(() => ({ open }), [open]);

  return (
    <LightboxContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        onClose={close}
        onCancel={(e) => {
          // 编辑中由编辑器自行处理 Esc，避免直接关闭预览
          if (editing) e.preventDefault();
        }}
        aria-label="图片预览"
        className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-transparent p-0 text-foreground backdrop:bg-black/85"
      >
        {current && !editing && (
          <div
            className="flex h-full w-full items-center justify-center p-4 sm:p-8"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
              {fileId && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={!canEdit || permission?.loading}
                  title={
                    !permission || permission.loading
                      ? "正在获取编辑权限…"
                      : canEdit
                        ? "编辑图片"
                        : permission.reason ?? "无权编辑该图片"
                  }
                  aria-label="编辑图片"
                  className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {!permission || permission.loading ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : (
                    <PenLine className="size-5" />
                  )}
                </button>
              )}
              <a
                href={src}
                download={current.name || ""}
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white"
                aria-label="下载图片"
                title="下载图片"
              >
                <Download className="size-5" />
              </a>
              <button
                type="button"
                onClick={close}
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white"
                aria-label="关闭预览"
                title="关闭"
              >
                <X className="size-5" />
              </button>
            </div>

            {images.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={previous}
                  className="absolute left-2 z-10 flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 sm:left-5"
                  aria-label="上一张"
                  title="上一张"
                >
                  <ChevronLeft className="size-7" />
                </button>
                <button
                  type="button"
                  onClick={next}
                  className="absolute right-2 z-10 flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 sm:right-5"
                  aria-label="下一张"
                  title="下一张"
                >
                  <ChevronRight className="size-7" />
                </button>
              </>
            )}

            <figure className="flex max-h-full max-w-full flex-col items-center gap-3">
              <img
                src={src}
                alt={current.name ?? ""}
                className="max-h-[82vh] max-w-[92vw] rounded-lg object-contain shadow-2xl sm:max-w-[88vw]"
              />
              <figcaption className="max-w-[92vw] truncate text-center text-sm text-white/80">
                {current.name}
                {images.length > 1 && (
                  <span className="ml-2 text-white/50">
                    {index + 1} / {images.length}
                  </span>
                )}
              </figcaption>
            </figure>
          </div>
        )}

        {current && editing && (
          <ImageEditor
            src={src}
            name={current.name}
            fileId={fileId}
            canEdit={canEdit}
            onClose={() => setEditing(false)}
            onSaved={() => {
              if (!fileId) return;
              setVersions((prev) => ({ ...prev, [fileId]: Date.now() }));
            }}
          />
        )}
      </dialog>
    </LightboxContext.Provider>
  );
}

/** 在 LightboxProvider 内部使用；无 Provider 时返回安全的空实现 */
export function useLightbox(): LightboxContextValue {
  return useContext(LightboxContext) ?? { open: () => {} };
}
