import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Eye, PenLine, X } from "lucide-react";
import { mutate } from "swr";
import { api } from "@/lib/api";
import { caretFromPoint } from "@/lib/caret";
import { todayStr } from "@/lib/utils";
import type { FileMeta, StudyLog } from "@/lib/types";
import { useToast } from "./toast";
import { FileUploader, MAX_ATTACHMENTS, buildAttachmentInsertion, stripFileMarkdown, uploadAttachmentFiles } from "./attachments";
import { Markdown } from "./markdown";
import { MarkdownToolbar } from "./markdown-toolbar";
import { Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea } from "./ui";

const QUICK_MINUTES = [30, 60, 90, 120];

export function LogDialog({
  open,
  onClose,
  tasks,
  defaultTaskId,
  editing,
  admin,
  inline,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  tasks: { id: number; title: string }[];
  defaultTaskId?: number;
  editing?: StudyLog | null;
  /** 管理员编辑学员日志：可以修改内容并增删批注附件 */
  admin?: boolean;
  /** 嵌入页面内的论坛式编辑面板，而不是弹出对话框 */
  inline?: boolean;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [minutes, setMinutes] = useState(editing?.minutes ?? 0);
  const [content, setContent] = useState(editing?.content ?? "");
  const [files, setFiles] = useState<FileMeta[]>(editing?.files ?? []);
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const savedRef = useRef(false);
  const contentRef = useRef(content);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaTouchedRef = useRef(false);
  const dropCaretRef = useRef<number | null>(null);
  const inlineRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!inline || !open) return;
    inlineRootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [inline, open]);

  function changeContent(next: string) {
    contentRef.current = next;
    setContent(next);
  }

  /** 把附件插入正文的指定位置，返回插入后的光标位置 */
  function insertAttachmentAt(file: FileMeta, at?: number) {
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

  /** 上传完成后把图片 / 压缩包插入到光标位置，形成“文字 - 附件 - 文字”的论坛式排版 */
  function insertAttachment(file: FileMeta) {
    insertAttachmentAt(file);
  }

  function insertDroppedAttachment(file: FileMeta) {
    dropCaretRef.current = insertAttachmentAt(file, dropCaretRef.current ?? undefined);
  }

  /** 工具栏的“插入附件”：上传后按工具栏点击时的光标位置插入正文 */
  async function uploadFromToolbar(selected: File[], selection: { start: number; end: number }) {
    let caret: number | null = selection.start;
    await uploadAttachmentFiles({
      files: selected,
      scope: "log",
      logId: editing?.id,
      max: MAX_ATTACHMENTS,
      current: countedFiles,
      onUploaded: (file) => {
        setFiles((prev) => [...prev, file]);
        caret = insertAttachmentAt(file, caret ?? undefined);
      },
      notify: toast,
    });
  }

  function onContentDragOver(e: DragEvent<HTMLTextAreaElement>) {
    if (admin && !editing) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  async function onContentDrop(e: DragEvent<HTMLTextAreaElement>) {
    if (admin && !editing) return;
    const dropped = Array.from(e.dataTransfer.files);
    if (!dropped.length) return;
    e.preventDefault();
    const el = textareaRef.current;
    if (!el) return;
    // 记录拖拽落点，上传期间即使用户移动了光标，附件仍会插入到拖拽的位置
    const fallback = textareaTouchedRef.current ? el.selectionStart : contentRef.current.length;
    const caret = caretFromPoint(el, e.clientX, e.clientY) ?? fallback;
    el.focus();
    el.setSelectionRange(caret, caret);
    textareaTouchedRef.current = true;
    dropCaretRef.current = caret;
    try {
      await uploadAttachmentFiles({
        files: dropped,
        scope: "log",
        logId: editing?.id,
        max: MAX_ATTACHMENTS,
        current: countedFiles,
        onUploaded: (file) => {
          setFiles((prev) => [...prev, file]);
          insertDroppedAttachment(file);
        },
        notify: toast,
      });
    } finally {
      dropCaretRef.current = null;
    }
  }

  function removeAttachment(id: string) {
    changeContent(stripFileMarkdown(contentRef.current, id));
    setFiles((prev) => prev.filter((file) => file.id !== id));
  }

  // 管理员的批注附件单独计算上限：学员自己的附件不占用管理员的批注名额
  const countedFiles =
    admin && editing?.user_id !== undefined
      ? files.filter((file) => file.uploader_id !== undefined && file.uploader_id !== editing.user_id).length
      : files.length;

  function close() {
    // 管理员上传的批注附件会立即绑定到日志；如果取消编辑，应删除本次新上传的附件，
    // 避免学员因为一条未保存的批注而被锁定、无法编辑最后一条日志。
    if (admin && editing && !savedRef.current) {
      const existing = new Set((editing.files ?? []).map((file) => file.id));
      for (const file of files) {
        const isNewAnnotation = !existing.has(file.id) && file.uploader_id !== undefined && file.uploader_id !== editing.user_id;
        if (isNewAnnotation) void api.del(`/api/files/${file.id}`).catch(() => {});
      }
    }
    savedRef.current = false;
    setFiles([]);
    setPreview(false);
    if (!editing) {
      setMinutes(0);
      changeContent("");
      textareaTouchedRef.current = false;
    }
    onClose();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    setError("");
    try {
      const taskId = form.get("task_id");
      const payload = {
        content,
        minutes,
        log_date: form.get("log_date"),
        task_id: taskId ? Number(taskId) : null,
        file_ids: files.filter((file) => !editing?.files?.some((f) => f.id === file.id)).map((file) => file.id),
      };
      if (admin && editing) await api.patch(`/api/admin/logs/${editing.id}`, payload);
      else if (editing) await api.patch(`/api/me/logs/${editing.id}`, payload);
      else await api.post("/api/me/logs", payload);
      await mutate((key) => typeof key === "string" && key.startsWith(admin ? "/api/admin/" : "/api/me/"));
      toast(editing ? "日志已更新" : "学习打卡成功");
      savedRef.current = true;
      setFiles([]);
      setPreview(false);
      if (!editing) {
        setMinutes(0);
        changeContent("");
        textareaTouchedRef.current = false;
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const title = editing ? "编辑日志" : "学习打卡";
  const description = editing ? "修改后会同步更新学习统计；支持 Markdown 与附件批注" : "记录今天学了什么，支持 Markdown 书写";
  const formBody = (
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button type="submit" loading={loading}>
            {editing ? "保存修改" : "提交打卡"}
          </Button>
        </div>
        {error && (
          <p className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="日期" htmlFor="log_date">
            <Input id="log_date" name="log_date" type="date" defaultValue={editing?.log_date ?? todayStr()} max={todayStr()} required />
          </Field>
          <Field label="关联任务" htmlFor="task_id">
            <Select id="task_id" name="task_id" defaultValue={editing ? (editing.task_id ?? "") : (defaultTaskId ?? "")}>
              <option value="">不关联</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="学习时长" htmlFor="minutes" hint="不确定时可以保持“未知”，不会影响打卡记录">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setMinutes(0)}
              className={`h-9 rounded-lg border px-3 text-sm transition-colors ${minutes === 0 ? "border-primary bg-primary-soft text-primary" : "hover:bg-muted"}`}
            >
              未知
            </button>
            {QUICK_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(m)}
                className={`h-9 rounded-lg border px-3 text-sm transition-colors ${minutes === m ? "border-primary bg-primary-soft text-primary" : "hover:bg-muted"}`}
              >
                {m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
              </button>
            ))}
            <div className="flex items-center gap-1.5">
              <Input
                id="minutes"
                type="number"
                min={0}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="h-9 w-20"
                aria-label="自定义分钟数"
              />
              <span className="text-sm text-muted-foreground">分钟</span>
            </div>
          </div>
        </Field>
        <Field
          label="学习内容"
          htmlFor="content"
          hint="支持 Markdown：标题、列表、粗体、链接、图片、代码块、表格，以及 <font color=&quot;red&quot;> 或 <span style=&quot;color:red&quot;> 等颜色写法"
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <MarkdownToolbar
                target={textareaRef}
                onChange={changeContent}
                onUploadFiles={admin && !editing ? undefined : uploadFromToolbar}
                disabled={preview || (admin && !editing)}
              />
              <div className="flex justify-end gap-1">
                <Button type="button" size="sm" variant={preview ? "ghost" : "secondary"} onClick={() => setPreview(false)}>
                  <PenLine /> 编写
                </Button>
                <Button type="button" size="sm" variant={preview ? "secondary" : "ghost"} onClick={() => setPreview(true)}>
                  <Eye /> 预览
                </Button>
              </div>
            </div>
            {preview ? (
              <div className="min-h-56 rounded-lg border bg-card px-3 py-2">
                {content.trim() ? <Markdown source={content} /> : <p className="text-sm text-muted-foreground">还没有内容</p>}
              </div>
            ) : (
              <Textarea
                id="content"
                name="content"
                ref={textareaRef}
                value={content}
                onChange={(e) => changeContent(e.target.value)}
                onFocus={() => {
                  textareaTouchedRef.current = true;
                }}
                onDragOver={onContentDragOver}
                onDrop={onContentDrop}
                required
                maxLength={10000}
                rows={12}
                className="min-h-56 font-mono text-[13px] leading-relaxed"
                placeholder={"例如：完成了 useEffect 的练习，理解了依赖数组的作用\n\n**今天的收获**：\n- 学会清理副作用\n- 理解了 <font color=\"red\">依赖数组</font> 的作用"}
              />
            )}
          </div>
        </Field>
        <Field label={admin ? "图片 / 压缩包 / 批注附件" : "图片 / 压缩包附件"}>
          <FileUploader
            files={files}
            scope="log"
            logId={editing?.id}
            max={MAX_ATTACHMENTS}
            count={countedFiles}
            hint={
              admin
                ? `上传的图片或 7z / tar 压缩包会插入到正文光标位置，学员看到时按顺序排列；最多 ${MAX_ATTACHMENTS} 个。`
                : `上传的图片或 7z / tar 压缩包会插入到正文光标位置，可以继续在下方输入文字；最多 ${MAX_ATTACHMENTS} 个。`
            }
            canRemove={
              admin && editing
                ? (file) => file.uploader_id !== undefined && file.uploader_id !== editing.user_id
                : undefined
            }
            disabled={admin && !editing}
            onUploaded={(file) => {
              setFiles((prev) => [...prev, file]);
              insertAttachment(file);
            }}
            onRemoved={removeAttachment}
          />
          {admin && !editing && <p className="mt-1 text-xs text-muted-foreground">保存日志后才可以添加管理员批注附件。</p>}
        </Field>
      </form>
  );

  if (inline) {
    if (!open) return null;
    return (
      <div ref={inlineRootRef} className="scroll-mt-24">
        <Card>
          <CardHeader
            title={title}
            description={description}
            action={
              <Button type="button" variant="ghost" size="icon" onClick={close} aria-label="关闭编辑面板" title="关闭编辑面板">
                <X />
              </Button>
            }
          />
          <div className="p-5">{formBody}</div>
        </Card>
      </div>
    );
  }

  return (
    <Dialog open={open} onClose={close} title={title} description={description} className="max-w-3xl">
      {formBody}
    </Dialog>
  );
}
