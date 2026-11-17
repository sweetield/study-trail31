import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import useSWR from "swr";
import { Eye, FileText, Loader2, MessageSquareText, Paperclip, PenLine, Send, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { caretFromPoint } from "@/lib/caret";
import type { FileMeta, LogReply } from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";
import { Markdown } from "./markdown";
import { MarkdownToolbar } from "./markdown-toolbar";
import { useLightbox } from "./lightbox";
import { Avatar } from "./avatar";
import { useToast } from "./toast";
import { Button } from "./ui";

export const MAX_UPLOAD_MB = 20;
export const MAX_ATTACHMENTS = 20;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const IMAGE_MIME = /^image\/(jpeg|png|gif|webp|bmp|avif)$/i;
/** 附件支持 7z / tar 压缩包（含分卷，如 .7z.001、.tar.001）与常见图片 */
const ARCHIVE_EXT = /\.(7z|tar)(\.\d{3})?$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
export const ATTACHMENT_ACCEPT = ".7z,.tar,.jpg,.jpeg,.png,.gif,.webp,.bmp,.avif";

/** 附件支持图片与 7z / tar 压缩包（含分卷），Office、脚本、Markdown、音视频等均不允许 */
function isAllowedUpload(file: File) {
  return ARCHIVE_EXT.test(file.name) || IMAGE_EXT.test(file.name);
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fileUrl(id: string) {
  return `/api/files/${id}`;
}

export function isImageFile(file: Pick<FileMeta, "mime">) {
  return IMAGE_MIME.test(file.mime);
}

const FILE_ID_IN_CONTENT = /\/api\/files\/([a-f0-9]{32})/g;

/** 收集正文中已经引用过的附件 ID，避免正文内嵌后又在下方重复显示 */
export function referencedFileIds(content?: string | null): Set<string> {
  const ids = new Set<string>();
  if (!content) return ids;
  FILE_ID_IN_CONTENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_ID_IN_CONTENT.exec(content))) ids.add(match[1]);
  return ids;
}

export function filesNotReferenced(files: FileMeta[] | undefined, content?: string | null): FileMeta[] {
  if (!files?.length) return [];
  const referenced = referencedFileIds(content);
  return files.filter((file) => !referenced.has(file.id));
}

/** 把附件插入正文时使用的 Markdown：图片直接内嵌，压缩包以链接展示 */
export function buildAttachmentInsertion(value: string, start: number, end: number, file: FileMeta) {
  const url = fileUrl(file.id);
  const name = file.name.replace(/[[\]\\]/g, "\\$&");
  const snippet = isImageFile(file) ? `![${name}](${url})` : `[${name}](${url})`;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = !after ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const inserted = `${prefix}${snippet}${suffix}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** 删除正文中引用某个附件的 Markdown，保留其余排版 */
export function stripFileMarkdown(content: string, id: string): string {
  const escaped = `/api/files/${id}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(new RegExp(`!?\\[(?:\\\\[\\[\\]]|[^\\[\\]\\\\])*\\]\\(${escaped}(?:\\s+"[^"]*")?\\)`, "g"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function FileChips({
  files,
  onRemove,
  canRemove,
  disabled,
  className,
}: {
  files: FileMeta[];
  onRemove?: (id: string) => void;
  /** 控制单个文件是否显示删除按钮；默认都可以删除 */
  canRemove?: (file: FileMeta) => boolean;
  disabled?: boolean;
  className?: string;
}) {
  const lightbox = useLightbox();
  if (!files.length) return null;
  const images = files.filter(isImageFile);
  const others = files.filter((file) => !isImageFile(file));
  const lightboxImages = images.map((file) => ({ src: fileUrl(file.id), name: file.name }));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((file, index) => (
            <div key={file.id} className="group relative size-24 shrink-0 overflow-hidden rounded-lg border bg-muted sm:size-28">
              <button
                type="button"
                onClick={() => lightbox.open(lightboxImages, index)}
                title={`点击放大预览 ${file.name}`}
                aria-label={`预览图片 ${file.name}`}
                className="block size-full cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <img
                  src={fileUrl(file.id)}
                  alt={file.name}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
              <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-3 pb-1 text-[10px] leading-tight text-white">
                {file.name}
              </span>
              {onRemove && !disabled && (!canRemove || canRemove(file)) && (
                <button
                  type="button"
                  onClick={() => onRemove(file.id)}
                  className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md bg-black/55 text-white transition-colors hover:bg-destructive"
                  aria-label={`删除附件 ${file.name}`}
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {others.map((file) => (
            <li key={file.id} className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <a href={fileUrl(file.id)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-primary" title={file.name}>
                {file.name}
              </a>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
              {onRemove && !disabled && (!canRemove || canRemove(file)) && (
                <button
                  type="button"
                  onClick={() => onRemove(file.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
                  aria-label={`删除附件 ${file.name}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface UploadOptions {
  files: File[];
  scope: "log" | "progress" | "task" | "review" | "reply" | "share";
  taskId?: number;
  logId?: number;
  shareId?: number;
  ownerUserId?: number;
  max: number;
  /** 当前已占用的附件数量 */
  current: number;
  onUploaded: (file: FileMeta) => void;
  notify?: (message: string, tone?: "error") => void;
}

/**
 * 校验并逐个上传附件，同时受单次数量上限约束。
 * 上传成功后立即回调，方便调用方把图片 / 文件插入到正文的指定位置。
 */
export async function uploadAttachmentFiles({
  files,
  scope,
  taskId,
  logId,
  shareId,
  ownerUserId,
  max,
  current,
  onUploaded,
  notify,
}: UploadOptions) {
  if (!files.length) return 0;
  if (current >= max) {
    notify?.(`最多上传 ${max} 个附件`, "error");
    return 0;
  }
  const room = max - current;
  if (files.length > room) notify?.(`最多还能上传 ${room} 个附件，多出的已忽略`, "error");

  let uploaded = 0;
  for (const file of files.slice(0, room)) {
    if (file.size > MAX_UPLOAD_BYTES) {
      notify?.(`「${file.name}」超过 ${MAX_UPLOAD_MB} MB，已跳过`, "error");
      continue;
    }
    if (!file.size) {
      notify?.(`「${file.name}」是空文件，已跳过`, "error");
      continue;
    }
    if (!isAllowedUpload(file)) {
      notify?.(`「${file.name}」格式不支持，仅支持图片或 7z / tar 压缩包（可上传分卷）`, "error");
      continue;
    }
    const form = new FormData();
    form.set("file", file);
    form.set("scope", scope);
    if (taskId) form.set("task_id", String(taskId));
    if (logId) form.set("log_id", String(logId));
    if (shareId) form.set("share_id", String(shareId));
    if (ownerUserId) form.set("owner_user_id", String(ownerUserId));
    try {
      const res = await api.upload<{ file: FileMeta }>("/api/files", form);
      onUploaded(res.file);
      uploaded += 1;
    } catch (err) {
      notify?.((err as Error).message, "error");
    }
  }
  return uploaded;
}

export function FileUploader({
  files,
  onUploaded,
  onRemoved,
  canRemove,
  scope,
  taskId,
  logId,
  shareId,
  ownerUserId,
  disabled,
  max = MAX_ATTACHMENTS,
  count,
  hint,
  compact,
}: {
  files: FileMeta[];
  onUploaded: (file: FileMeta) => void;
  onRemoved: (id: string) => void;
  /** 控制单个文件是否显示删除按钮；默认都可以删除 */
  canRemove?: (file: FileMeta) => boolean;
  scope: "log" | "progress" | "task" | "review" | "reply" | "share";
  taskId?: number;
  logId?: number;
  shareId?: number;
  ownerUserId?: number;
  disabled?: boolean;
  max?: number;
  /** 计入上限的文件数量；默认等于 files.length */
  count?: number;
  hint?: string;
  compact?: boolean;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const current = count ?? files.length;

  async function uploadFiles(selected: File[]) {
    if (!selected.length) return;
    setUploading(true);
    try {
      await uploadAttachmentFiles({
        files: selected,
        scope,
        taskId,
        logId,
        shareId,
        ownerUserId,
        max,
        current,
        onUploaded,
        notify: toast,
      });
    } finally {
      setUploading(false);
    }
  }

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    e.currentTarget.value = "";
    await uploadFiles(selected);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (disabled) return;
    e.preventDefault();
    setDragActive(false);
    void uploadFiles(Array.from(e.dataTransfer.files));
  }

  async function remove(id: string) {
    if (!confirm("确定删除这个附件吗？")) return;
    try {
      await api.del(`/api/files/${id}`);
      onRemoved(id);
      toast("附件已删除");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl transition-colors",
        !disabled && "border border-dashed p-2.5",
        dragActive && !disabled && "border-primary bg-primary-soft/50",
      )}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <FileChips files={files} onRemove={remove} canRemove={canRemove} disabled={disabled} />
      {!disabled && (
        <>
          <input ref={inputRef} type="file" multiple accept={ATTACHMENT_ACCEPT} className="hidden" onChange={onPick} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={uploading || current >= max}
            >
              {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
              {uploading ? "上传中…" : dragActive ? "松开即可上传" : "上传附件"}
            </Button>
            <span className="text-xs text-muted-foreground">{dragActive ? "拖到这里" : "也可拖拽图片或压缩包到此"}</span>
          </div>
        </>
      )}
      {!disabled && !compact && (
        <p className="text-xs text-muted-foreground">
          {hint ??
            `支持图片与 7z / tar 压缩包（可分卷），单个不超过 ${MAX_UPLOAD_MB} MB，最多 ${max} 个。`}
        </p>
      )}
    </div>
  );
}

function ReplyBubble({ reply, nested }: { reply: LogReply; nested?: boolean }) {
  const isStudent = reply.author_role === "student";
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        nested
          ? "ml-3 border-amber-200/70 bg-amber-50/70"
          : isStudent
            ? "border-border bg-muted/60"
            : "border-primary/15 bg-primary-soft/60",
      )}
    >
      <p className="mb-0.5 flex flex-wrap items-center gap-1.5 text-xs font-medium text-primary">
        <MessageSquareText className="size-3.5" aria-hidden="true" />
        <Avatar name={reply.author_name} avatarId={reply.author_avatar_id} className="size-5 text-[10px]" />
        {isStudent ? "学员" : "辅导员"} · {reply.author_name} · {formatTime(reply.created_at)}
      </p>
      {reply.content.trim() && <Markdown source={reply.content} className="text-sm" />}
      {filesNotReferenced(reply.files, reply.content).length > 0 && (
        <FileChips files={filesNotReferenced(reply.files, reply.content)} className="mt-2" />
      )}
    </div>
  );
}

function ReplyComposer({
  logId,
  role,
  parentId,
  onDone,
  placeholder,
}: {
  logId: number;
  role: "admin" | "student";
  parentId?: number | null;
  onDone?: () => void;
  placeholder?: string;
}) {
  const toast = useToast();
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const contentRef = useRef(content);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaTouchedRef = useRef(false);
  const dropCaretRef = useRef<number | null>(null);

  function changeContent(next: string) {
    contentRef.current = next;
    setContent(next);
  }

  function insertAttachment(file: FileMeta, at?: number) {
    const el = textareaRef.current;
    const value = contentRef.current;
    const start = at ?? (el && textareaTouchedRef.current ? el.selectionStart : value.length);
    const end = at ?? (el && textareaTouchedRef.current ? el.selectionEnd : value.length);
    const next = buildAttachmentInsertion(value, start, end, file);
    changeContent(next.value);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
    return next.caret;
  }

  async function uploadFromToolbar(selected: File[], selection: { start: number; end: number }) {
    let caret: number | null = selection.start;
    await uploadAttachmentFiles({
      files: selected,
      scope: "reply",
      logId,
      max: MAX_ATTACHMENTS,
      current: files.length,
      onUploaded: (file) => {
        setFiles((prev) => [...prev, file]);
        caret = insertAttachment(file, caret ?? undefined);
      },
      notify: toast,
    });
  }

  function onContentDragOver(e: DragEvent<HTMLTextAreaElement>) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  async function onContentDrop(e: DragEvent<HTMLTextAreaElement>) {
    const dropped = Array.from(e.dataTransfer.files);
    if (!dropped.length) return;
    e.preventDefault();
    const el = textareaRef.current;
    if (!el) return;
    // 记录拖拽落点，上传期间即使用户移动了光标，附件仍插入到鼠标落下的字符位置
    const fallback = textareaTouchedRef.current ? el.selectionStart : contentRef.current.length;
    const caret = caretFromPoint(el, e.clientX, e.clientY) ?? fallback;
    el.focus();
    el.setSelectionRange(caret, caret);
    textareaTouchedRef.current = true;
    dropCaretRef.current = caret;
    try {
      await uploadAttachmentFiles({
        files: dropped,
        scope: "reply",
        logId,
        max: MAX_ATTACHMENTS,
        current: files.length,
        onUploaded: (file) => {
          setFiles((prev) => [...prev, file]);
          dropCaretRef.current = insertAttachment(file, dropCaretRef.current ?? undefined);
        },
        notify: toast,
      });
    } finally {
      dropCaretRef.current = null;
    }
  }

  function removeDraftFile(id: string) {
    setFiles((prev) => prev.filter((file) => file.id !== id));
    changeContent(stripFileMarkdown(contentRef.current, id));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!content.trim() && !files.length) return;
    setBusy(true);
    try {
      const url = role === "admin" ? `/api/admin/logs/${logId}/replies` : `/api/me/logs/${logId}/replies`;
      await api.post(url, {
        content: content.trim(),
        parent_id: parentId ?? null,
        file_ids: files.map((file) => file.id),
      });
      changeContent("");
      setFiles([]);
      setPreview(false);
      onDone?.();
      toast(role === "admin" ? "留言已发送，学员会收到通知" : "回复已发送，辅导员会收到通知");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1.5">
        <MarkdownToolbar
          target={textareaRef}
          onChange={changeContent}
          onUploadFiles={uploadFromToolbar}
          disabled={preview}
          className="border-0 bg-transparent p-0"
        />
        <div className="flex gap-1">
          <Button type="button" size="sm" variant={preview ? "ghost" : "secondary"} onClick={() => setPreview(false)}>
            <PenLine /> 编写
          </Button>
          <Button type="button" size="sm" variant={preview ? "secondary" : "ghost"} onClick={() => setPreview(true)}>
            <Eye /> 预览
          </Button>
        </div>
      </div>
      <div className="px-3 pt-2">
        {preview ? (
          <div className="min-h-44 rounded-lg border bg-muted/20 px-3 py-2">
            {content.trim() ? <Markdown source={content} /> : <p className="text-sm text-muted-foreground">还没有内容</p>}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => changeContent(e.target.value)}
            onFocus={() => {
              textareaTouchedRef.current = true;
            }}
            onDragOver={onContentDragOver}
            onDrop={onContentDrop}
            rows={6}
            maxLength={2000}
            placeholder={placeholder ?? (role === "admin" ? "给学员留言或答疑…" : "回复辅导员的留言…")}
            aria-label={role === "admin" ? "给学员留言" : "回复辅导员留言"}
            className="min-h-44 w-full resize-y rounded-lg border bg-card px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
        )}
      </div>
      <div className="px-3 pt-2">
        <FileUploader
          files={files}
          onUploaded={(file) => {
            setFiles((prev) => [...prev, file]);
            insertAttachment(file);
          }}
          onRemoved={removeDraftFile}
          scope="reply"
          logId={logId}
          max={MAX_ATTACHMENTS}
          compact
          hint={`最多 ${MAX_ATTACHMENTS} 个图片或 7z / tar 压缩包，单个不超过 ${MAX_UPLOAD_MB} MB`}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-3 py-2">
        <span className="text-xs text-muted-foreground">支持 Markdown，可直接拖入图片或 7z / tar 压缩包插入到落点</span>
        <Button type="submit" size="sm" loading={busy} disabled={!content.trim() && !files.length}>
          <Send /> {role === "admin" ? "发送留言" : "回复"}
        </Button>
      </div>
    </form>
  );
}

export function ReplyThread({
  replies,
  logId,
  role = "student",
  onReplied,
  className,
}: {
  replies?: LogReply[];
  /** 日志 ID，提供后会显示留言 / 回复输入框 */
  logId?: number;
  /** 当前查看者身份，决定调用管理员还是学员接口 */
  role?: "admin" | "student";
  onReplied?: () => void;
  className?: string;
}) {
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  // 管理员的留言框默认收起，避免每条日志下方都占出一大块编辑区域
  const [composerOpen, setComposerOpen] = useState(false);
  const list = replies ?? [];
  const byId = new Map(list.map((reply) => [reply.id, reply]));
  const rootIdOf = (reply: LogReply) => {
    let current = reply;
    const seen = new Set<number>();
    while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent_id)!;
    }
    return current.id;
  };
  const threads = new Map<number, LogReply[]>();
  for (const reply of list) {
    const rootId = rootIdOf(reply);
    threads.set(rootId, [...(threads.get(rootId) ?? []), reply]);
  }
  const roots = list.filter((reply) => !reply.parent_id || !byId.has(reply.parent_id));

  if (!list.length && !(role === "admin" && logId)) return null;

  return (
    <div className={cn("mt-2 flex flex-col gap-2", className)}>
      {roots.map((reply) => {
        const thread = threads.get(reply.id) ?? [reply];
        const replyChildren = thread.filter((child) => child.id !== reply.id);
        const replyable = role === "student" && !!logId && reply.author_role !== "student";
        return (
          <div key={reply.id} className="flex flex-col gap-2">
            <ReplyBubble reply={reply} />
            {replyChildren.map((child) => (
              <ReplyBubble key={child.id} reply={child} nested />
            ))}
            {replyable && (
              <div className="pl-3">
                {replyingTo === reply.id ? (
                  <ReplyComposer
                    logId={logId!}
                    role={role}
                    parentId={reply.id}
                    placeholder={`回复 ${reply.author_name} 的留言…`}
                    onDone={() => {
                      setReplyingTo(null);
                      onReplied?.();
                    }}
                  />
                ) : (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReplyingTo(reply.id)}>
                    <MessageSquareText /> 回复
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {role === "admin" && logId && (
        composerOpen ? (
          <ReplyComposer
            logId={logId}
            role={role}
            onDone={() => {
              setComposerOpen(false);
              onReplied?.();
            }}
            placeholder={roots.length ? "继续给学员留言或答疑…" : "给学员留言，可直接拖入图片或压缩包…"}
          />
        ) : (
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setComposerOpen(true)}>
            <MessageSquareText /> 回复
          </Button>
        )
      )}
    </div>
  );
}

/**
 * 学员端日志列表的留言区：默认自动展开有辅导员留言的日志，
 * 没有留言的日志保持轻量，不发起额外请求。
 */
export function LazyReplyThread({
  logId,
  hasReplies,
  onReplied,
  className,
}: {
  logId: number;
  hasReplies?: boolean;
  onReplied?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(!!hasReplies);
  // 页面打开后又收到新的辅导员留言时，同步自动展开
  useEffect(() => {
    if (hasReplies) setOpen(true);
  }, [hasReplies]);
  const { data, isLoading, mutate } = useSWR<{ replies: LogReply[] }>(open ? `/api/me/logs/${logId}/replies` : null);

  if (!open) {
    if (!hasReplies) return null;
    return (
      <Button type="button" variant="ghost" size="sm" className={cn("mt-2 self-start", className)} onClick={() => setOpen(true)}>
        <MessageSquareText /> 查看辅导员留言
      </Button>
    );
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {isLoading && !data ? (
        <p className="mt-2 text-xs text-muted-foreground">正在加载留言…</p>
      ) : (
        <ReplyThread
          replies={data?.replies}
          logId={logId}
          role="student"
          onReplied={() => {
            void mutate();
            onReplied?.();
          }}
        />
      )}
      <button
        type="button"
        className="mt-1 self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen(false)}
      >
        收起留言
      </button>
    </div>
  );
}
