import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import useSWR, { mutate } from "swr";
import { ArrowDown, ArrowLeft, ArrowUp, Eye, GripVertical, Maximize2, Minimize2, PenLine, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { caretFromPoint } from "@/lib/caret";
import type { AudienceMode, AudienceStudent, ClassItem, FileMeta, Step } from "@/lib/types";
import { PRIORITY_OPTIONS } from "@/lib/status";
import { cn, splitTags } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { AudiencePicker, type AudienceValue } from "@/components/audience-picker";
import { FileUploader, MAX_ATTACHMENTS, buildAttachmentInsertion, stripFileMarkdown, uploadAttachmentFiles } from "@/components/attachments";
import { Markdown } from "@/components/markdown";
import { MarkdownToolbar } from "@/components/markdown-toolbar";
import { Button, Card, CardHeader, Field, Input, PageHeader, PageLoader, Select, Textarea } from "@/components/ui";

interface TaskDetail {
  task: {
    id: number;
    title: string;
    description: string;
    tech_tags: string;
    class_id: number | null;
    due_date: string | null;
    status: string;
    require_review: number;
    priority: number;
    audience_mode: AudienceMode;
  };
  steps: Step[];
  class_ids: number[];
  excluded_user_ids: number[];
  task_files: FileMeta[];
}

type DraftStep = { key: string; id?: number; title: string };

const TAG_SUGGESTIONS = ["HTML", "CSS", "JavaScript", "TypeScript", "React", "Vue", "Node.js", "Git", "SQL", "Python", "Docker", "Linux"];

export default function AdminTaskEditor() {
  const { id } = useParams();
  const { data, isLoading } = useSWR<TaskDetail>(id ? `/api/admin/tasks/${id}` : null);
  if (id && (isLoading || !data)) return <PageLoader />;
  return <Editor key={id ?? "new"} initial={data} />;
}

function Editor({ initial }: { initial?: TaskDetail }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: classData } = useSWR<{ classes: ClassItem[] }>("/api/admin/classes");
  const { data: studentData } = useSWR<{ students: AudienceStudent[] }>("/api/admin/students/options");
  const isEdit = !!initial;
  const [tags, setTags] = useState<string[]>(splitTags(initial?.task.tech_tags));
  const [tagInput, setTagInput] = useState("");
  const [audience, setAudience] = useState<AudienceValue>({
    classIds: initial?.class_ids?.length ? initial.class_ids : initial?.task.class_id ? [initial.task.class_id] : [],
    excluded: initial?.excluded_user_ids ?? [],
    mode: initial?.task.audience_mode ?? "exclude",
  });
  const [steps, setSteps] = useState<DraftStep[]>(
    initial?.steps.length ? initial.steps.map((s) => ({ key: String(s.id), id: s.id, title: s.title })) : [{ key: "n0", title: "" }],
  );
  const [requireReview, setRequireReview] = useState(initial ? !!initial.task.require_review : true);
  const [priority, setPriority] = useState(initial?.task.priority ?? 0);
  const [files, setFiles] = useState<FileMeta[]>(initial?.task_files ?? []);
  const [description, setDescription] = useState(initial?.task.description ?? "");
  const [preview, setPreview] = useState(false);
  const [wideEdit, setWideEdit] = useState(false);
  const descriptionValueRef = useRef(description);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionTouchedRef = useRef(false);
  const dropCaretRef = useRef<number | null>(null);

  function changeDescription(next: string) {
    descriptionValueRef.current = next;
    setDescription(next);
  }

  /** 上传后把附件插入任务说明的指定位置，让图片 / 文件按编辑顺序显示 */
  function insertTaskAttachment(file: FileMeta, at?: number) {
    const el = descriptionRef.current;
    const value = descriptionValueRef.current;
    const start = at ?? (el && descriptionTouchedRef.current ? el.selectionStart : value.length);
    const end = at ?? (el && descriptionTouchedRef.current ? el.selectionEnd : value.length);
    const next = buildAttachmentInsertion(value, start, end, file);
    changeDescription(next.value);
    requestAnimationFrame(() => {
      const node = descriptionRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
    return next.caret;
  }

  function insertDroppedTaskAttachment(file: FileMeta) {
    dropCaretRef.current = insertTaskAttachment(file, dropCaretRef.current ?? undefined);
  }

  /** 工具栏的“插入图片 / 文件”：上传后按工具栏点击时的光标位置插入任务说明 */
  async function uploadFromToolbar(selected: File[], selection: { start: number; end: number }) {
    let caret: number | null = selection.start;
    await uploadAttachmentFiles({
      files: selected,
      scope: "task",
      taskId: initial?.task.id,
      max: MAX_ATTACHMENTS,
      current: files.length,
      onUploaded: (file) => {
        setFiles((prev) => [...prev, file]);
        caret = insertTaskAttachment(file, caret ?? undefined);
      },
      notify: toast,
    });
  }

  function onDescriptionDragOver(e: DragEvent<HTMLTextAreaElement>) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  async function onDescriptionDrop(e: DragEvent<HTMLTextAreaElement>) {
    const dropped = Array.from(e.dataTransfer.files);
    if (!dropped.length) return;
    e.preventDefault();
    const el = descriptionRef.current;
    if (!el) return;
    // 记录拖拽落点，上传完成后附件仍然插入到这个位置
    const fallback = descriptionTouchedRef.current ? el.selectionStart : descriptionValueRef.current.length;
    const caret = caretFromPoint(el, e.clientX, e.clientY) ?? fallback;
    el.focus();
    el.setSelectionRange(caret, caret);
    descriptionTouchedRef.current = true;
    dropCaretRef.current = caret;
    try {
      await uploadAttachmentFiles({
        files: dropped,
        scope: "task",
        taskId: initial?.task.id,
        max: MAX_ATTACHMENTS,
        current: files.length,
        onUploaded: (file) => {
          setFiles((prev) => [...prev, file]);
          insertDroppedTaskAttachment(file);
        },
        notify: toast,
      });
    } finally {
      dropCaretRef.current = null;
    }
  }

  function removeTaskAttachment(fileId: string) {
    changeDescription(stripFileMarkdown(descriptionValueRef.current, fileId));
    setFiles((prev) => prev.filter((file) => file.id !== fileId));
  }
  const initialFileIds = useState(() => new Set((initial?.task_files ?? []).map((file) => file.id)))[0];
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");

  function addTag(raw: string) {
    const parts = raw.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
    if (parts.length) setTags((prev) => [...new Set([...prev, ...parts])].slice(0, 12));
    setTagInput("");
  }

  function onTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && !tagInput && tags.length) {
      setTags((t) => t.slice(0, -1));
    }
  }

  function updateStep(key: string, title: string) {
    if (title.includes("\n")) {
      const lines = title.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      setSteps((prev) => {
        const idx = prev.findIndex((s) => s.key === key);
        const next = [...prev];
        next.splice(idx, 1, { ...prev[idx], title: lines[0] ?? "" }, ...lines.slice(1).map((l, i) => ({ key: `n${Date.now()}${i}`, title: l })));
        return next;
      });
      return;
    }
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, title } : s)));
  }

  function moveStep(index: number, dir: -1 | 1) {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save(e: FormEvent<HTMLFormElement>, status: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(status);
    setError("");
    const payload = {
      title: form.get("title"),
      description,
      tech_tags: [...tags, ...(tagInput.trim() ? [tagInput.trim()] : [])],
      class_ids: audience.classIds,
      excluded_user_ids: audience.excluded,
      audience_mode: audience.mode,
      due_date: form.get("due_date") || null,
      status,
      require_review: requireReview,
      priority,
      steps: steps.filter((s) => s.title.trim()).map((s) => ({ id: s.id, title: s.title })),
      file_ids: files.filter((file) => !initialFileIds.has(file.id)).map((file) => file.id),
    };
    try {
      let taskId = initial?.task.id;
      if (isEdit) await api.put(`/api/admin/tasks/${taskId}`, payload);
      else taskId = (await api.post<{ task: { id: number } }>("/api/admin/tasks", payload)).task.id;
      await mutate((key) => typeof key === "string" && key.startsWith("/api/admin/"));
      toast(status === "draft" ? "已保存为草稿" : isEdit ? "任务已更新" : "任务已发布，学员现在可以看到了");
      navigate(`/admin/tasks/${taskId}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const submitter = (status: string) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form!;
    if (!form.reportValidity()) return;
    save({ preventDefault() {}, currentTarget: form } as unknown as FormEvent<HTMLFormElement>, status);
  };

  return (
    <form
      className="flex flex-col gap-6"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
      }}
      onSubmit={(e) => save(e, initial?.task.status === "archived" ? "archived" : "published")}>
      <div className="flex flex-col gap-3">
        <Link to={isEdit ? `/admin/tasks/${initial!.task.id}` : "/admin/tasks"} className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> 返回
        </Link>
        <PageHeader
          title={isEdit ? "编辑任务" : "发布新任务"}
          description="拆分清晰的学习步骤，学员更容易坚持，也方便你掌握进度"
          action={
            <>
              {(!isEdit || initial?.task.status === "draft") && (
                <Button variant="outline" onClick={submitter("draft")} loading={saving === "draft"}>
                  保存草稿
                </Button>
              )}
              <Button type="submit" loading={saving !== null && saving !== "draft"}>
                {isEdit && initial?.task.status !== "draft" ? "保存修改" : "立即发布"}
              </Button>
            </>
          }
        />
      </div>

      {error && (
        <p className="rounded-lg bg-destructive-soft px-4 py-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className={cn("grid gap-6", wideEdit ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title="基本信息" />
            <div className="flex flex-col gap-4 p-5">
              <Field label="任务标题" htmlFor="title">
                <Input id="title" name="title" required maxLength={100} defaultValue={initial?.task.title} placeholder="例如：React Hooks 实战练习" />
              </Field>
              <Field label="学习技术" htmlFor="tag-input" hint="输入后按回车添加，可点击下方推荐快速添加">
                <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
                  {tags.map((t) => (
                    <span key={t} className="flex items-center gap-1 rounded-md bg-primary-soft py-0.5 pr-1 pl-2 font-mono text-xs text-primary">
                      {t}
                      <button type="button" onClick={() => setTags((p) => p.filter((x) => x !== t))} aria-label={`移除 ${t}`} className="rounded p-0.5 hover:bg-primary/10">
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    id="tag-input"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={onTagKey}
                    onBlur={() => tagInput && addTag(tagInput)}
                    className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none"
                    placeholder={tags.length ? "" : "React, TypeScript"}
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {TAG_SUGGESTIONS.filter((s) => !tags.includes(s)).map((s) => (
                    <button key={s} type="button" onClick={() => addTag(s)} className="rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary">
                      + {s}
                    </button>
                  ))}
                </div>
              </Field>
              <Field
                label="任务说明"
                htmlFor="description"
                hint="支持 Markdown：标题、列表、粗体、链接、图片、代码块、表格，以及 <font color=&quot;red&quot;> 或 <span style=&quot;color:red&quot;> 等颜色写法；学员查看时会自动渲染"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <MarkdownToolbar
                      target={descriptionRef}
                      onChange={changeDescription}
                      onUploadFiles={uploadFromToolbar}
                      disabled={preview}
                    />
                    <div className="flex justify-end gap-1">
                      <Button type="button" size="sm" variant={preview ? "ghost" : "secondary"} onClick={() => setPreview(false)}>
                        <PenLine /> 编写
                      </Button>
                      <Button type="button" size="sm" variant={preview ? "secondary" : "ghost"} onClick={() => setPreview(true)}>
                        <Eye /> 预览
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setWideEdit((value) => !value)}
                        title={wideEdit ? "还原编辑区" : "放大编辑区，隐藏右侧发布设置"}
                        aria-pressed={wideEdit}
                      >
                        {wideEdit ? <Minimize2 /> : <Maximize2 />} {wideEdit ? "还原" : "放大"}
                      </Button>
                    </div>
                  </div>
                  {preview ? (
                    <div className={cn("rounded-lg border bg-card px-4 py-3", wideEdit ? "min-h-[65vh]" : "min-h-[30rem]")}>
                      {description.trim() ? <Markdown source={description} className="reading-body" /> : <p className="text-sm text-muted-foreground">还没有内容</p>}
                    </div>
                  ) : (
                    <Textarea
                      id="description"
                      name="description"
                      ref={descriptionRef}
                      rows={wideEdit ? 24 : 18}
                      maxLength={20000}
                      className={cn("resize-y font-mono text-sm leading-6", wideEdit ? "min-h-[65vh]" : "min-h-[30rem]")}
                      value={description}
                      onChange={(e) => changeDescription(e.target.value)}
                      onFocus={() => {
                        descriptionTouchedRef.current = true;
                      }}
                      onDragOver={onDescriptionDragOver}
                      onDrop={onDescriptionDrop}
                      placeholder={"## 学习目标\n\n- 理解 React Hooks 的基本用法\n- 完成一个 Todo 示例\n\n**提交要求**：提交 GitHub 仓库链接\n\n<font color=\"red\">注意</font>：请在本周五前提交"}
                    />
                  )}
                </div>
              </Field>
              <Field label="任务说明附件" hint="支持图片和 7z / tar 压缩包（可上传分卷）；上传后自动插入到任务说明的光标位置，供学员查看或下载">
                <FileUploader
                  files={files}
                  scope="task"
                  taskId={initial?.task.id}
                  max={MAX_ATTACHMENTS}
                  onUploaded={(file) => {
                    setFiles((prev) => [...prev, file]);
                    insertTaskAttachment(file);
                  }}
                  onRemoved={removeTaskAttachment}
                />
                {!initial && files.length > 0 && <p className="mt-1 text-xs text-muted-foreground">发布任务后会自动绑定这些附件。</p>}
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="学习步骤" description="学员逐项勾选，进度自动计算。支持粘贴多行批量添加。留空则由学员手动填写进度。" />
            <ol className="flex flex-col gap-2 p-5">
              {steps.map((s, i) => (
                <li key={s.key} className="flex items-center gap-2">
                  <GripVertical className="size-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
                  <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  <Input
                    value={s.title}
                    onChange={(e) => updateStep(s.key, e.target.value)}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      if (text.includes("\n")) {
                        e.preventDefault();
                        updateStep(s.key, s.title + text);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                        e.preventDefault();
                        setSteps((prev) => [...prev.slice(0, i + 1), { key: `n${Date.now()}`, title: "" }, ...prev.slice(i + 1)]);
                        requestAnimationFrame(() => (document.querySelectorAll<HTMLInputElement>("[data-step-input]")[i + 1])?.focus());
                      }
                    }}
                    data-step-input
                    maxLength={200}
                    placeholder={`步骤 ${i + 1}，例如：阅读官方文档并完成示例`}
                    aria-label={`步骤 ${i + 1}`}
                  />
                  <div className="flex shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="上移">
                      <ArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} aria-label="下移">
                      <ArrowDown />
                    </Button>
                    <Button variant="destructive-ghost" size="icon" onClick={() => setSteps((p) => p.filter((x) => x.key !== s.key))} aria-label="删除步骤">
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
              <Button variant="outline" className="mt-1 self-start" onClick={() => setSteps((p) => [...p, { key: `n${Date.now()}`, title: "" }])}>
                <Plus /> 添加步骤
              </Button>
            </ol>
          </Card>
        </div>

        <Card className={cn("lg:sticky lg:top-8 lg:self-start", wideEdit && "hidden")}>
          <CardHeader title="发布设置" />
          <div className="flex flex-col gap-4 p-5">
            <AudiencePicker
              noun="任务"
              classes={classData?.classes ?? []}
              students={studentData?.students ?? []}
              value={audience}
              onChange={setAudience}
            />
            <Field label="截止日期" htmlFor="due_date" hint="可选，临近截止时学员会看到提醒">
              <Input id="due_date" name="due_date" type="date" defaultValue={initial?.task.due_date ?? ""} />
            </Field>
            <Field label="任务优先级" htmlFor="priority" hint="高优先级任务会排在学员任务列表前面；已置顶的任务始终排在最前，优先于高优先级">
              <Select id="priority" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50">
              <input type="checkbox" checked={requireReview} onChange={(e) => setRequireReview(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
              <span>
                <span className="block text-sm font-medium">需要辅导员审核</span>
                <span className="block text-xs text-muted-foreground">关闭后，学员提交即视为完成</span>
              </span>
            </label>
          </div>
        </Card>
      </div>
    </form>
  );
}
