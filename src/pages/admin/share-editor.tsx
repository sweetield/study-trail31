import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import useSWR, { mutate } from "swr";
import { ArrowLeft, Eye, Maximize2, Minimize2, PenLine, X } from "lucide-react";
import { api } from "@/lib/api";
import { caretFromPoint } from "@/lib/caret";
import type { AdminShare, AudienceStudent, ClassItem, FileMeta } from "@/lib/types";
import { cn, splitTags } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { AudiencePicker, type AudienceValue } from "@/components/audience-picker";
import { FileUploader, MAX_ATTACHMENTS, buildAttachmentInsertion, stripFileMarkdown, uploadAttachmentFiles } from "@/components/attachments";
import { Markdown } from "@/components/markdown";
import { MarkdownToolbar } from "@/components/markdown-toolbar";
import { Button, Card, CardHeader, Field, Input, PageHeader, PageLoader, Textarea } from "@/components/ui";

interface ShareEditorData {
  share: AdminShare & { description: string };
  files: FileMeta[];
  class_ids: number[];
  excluded_user_ids: number[];
}

const TAG_SUGGESTIONS = ["前端", "后端", "面试题", "学习路线", "工具", "文档", "视频", "源码"];

export default function AdminShareEditor() {
  const { id } = useParams();
  const { data, isLoading } = useSWR<ShareEditorData>(id ? `/api/admin/shares/${id}` : null);
  if (id && (isLoading || !data)) return <PageLoader />;
  return <Editor key={id ?? "new"} initial={data} />;
}

function Editor({ initial }: { initial?: ShareEditorData }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: classData } = useSWR<{ classes: ClassItem[] }>("/api/admin/classes");
  const { data: studentData } = useSWR<{ students: AudienceStudent[] }>("/api/admin/students/options");
  const { data: tagData } = useSWR<{ tags: { tag: string; count: number }[] }>("/api/admin/share-tags");
  const isEdit = !!initial;
  const [tags, setTags] = useState<string[]>(splitTags(initial?.share.tech_tags));
  const [tagInput, setTagInput] = useState("");
  const [audience, setAudience] = useState<AudienceValue>({
    classIds: initial?.class_ids ?? [],
    excluded: initial?.excluded_user_ids ?? [],
    mode: initial?.share.audience_mode ?? "exclude",
  });
  const [notify, setNotify] = useState(false);
  const [files, setFiles] = useState<FileMeta[]>(initial?.files ?? []);
  const [description, setDescription] = useState(initial?.share.description ?? "");
  const [preview, setPreview] = useState(false);
  const [wideEdit, setWideEdit] = useState(false);
  const descriptionValueRef = useRef(description);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionTouchedRef = useRef(false);
  const dropCaretRef = useRef<number | null>(null);
  const initialFileIds = useState(() => new Set((initial?.files ?? []).map((file) => file.id)))[0];
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");

  const suggestions = [
    ...new Set([...(tagData?.tags.map((item) => item.tag) ?? []), ...TAG_SUGGESTIONS]),
  ].filter((tag) => !tags.includes(tag));

  function changeDescription(next: string) {
    descriptionValueRef.current = next;
    setDescription(next);
  }

  /** 上传后把附件插入正文的指定位置，与任务说明附件的编辑体验保持一致 */
  function insertShareAttachment(file: FileMeta, at?: number) {
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

  async function uploadFromToolbar(selected: File[], selection: { start: number; end: number }) {
    let caret: number | null = selection.start;
    await uploadAttachmentFiles({
      files: selected,
      scope: "share",
      shareId: initial?.share.id,
      max: MAX_ATTACHMENTS,
      current: files.length,
      onUploaded: (file) => {
        setFiles((prev) => [...prev, file]);
        caret = insertShareAttachment(file, caret ?? undefined);
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
    const fallback = descriptionTouchedRef.current ? el.selectionStart : descriptionValueRef.current.length;
    const caret = caretFromPoint(el, e.clientX, e.clientY) ?? fallback;
    el.focus();
    el.setSelectionRange(caret, caret);
    descriptionTouchedRef.current = true;
    dropCaretRef.current = caret;
    try {
      await uploadAttachmentFiles({
        files: dropped,
        scope: "share",
        shareId: initial?.share.id,
        max: MAX_ATTACHMENTS,
        current: files.length,
        onUploaded: (file) => {
          setFiles((prev) => [...prev, file]);
          dropCaretRef.current = insertShareAttachment(file, dropCaretRef.current ?? undefined);
        },
        notify: toast,
      });
    } finally {
      dropCaretRef.current = null;
    }
  }

  function removeShareAttachment(fileId: string) {
    changeDescription(stripFileMarkdown(descriptionValueRef.current, fileId));
    setFiles((prev) => prev.filter((file) => file.id !== fileId));
  }

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

  async function save(e: FormEvent<HTMLFormElement>, status: string) {
    e.preventDefault();
    setSaving(status);
    setError("");
    const payload = {
      title: new FormData(e.currentTarget).get("title"),
      description,
      tech_tags: [...tags, ...(tagInput.trim() ? [tagInput.trim()] : [])],
      class_ids: audience.classIds,
      excluded_user_ids: audience.excluded,
      audience_mode: audience.mode,
      status,
      notify: notify && status === "published",
      file_ids: files.filter((file) => !initialFileIds.has(file.id)).map((file) => file.id),
    };
    try {
      let shareId = initial?.share.id;
      if (isEdit) await api.put(`/api/admin/shares/${shareId}`, payload);
      else shareId = (await api.post<{ share: { id: number } }>("/api/admin/shares", payload)).share.id;
      await mutate((key) => typeof key === "string" && key.startsWith("/api/admin/"));
      toast(status === "draft" ? "已保存为草稿" : isEdit ? "资料已更新" : "资料已发布，学员现在可以查看");
      navigate(`/admin/shares/${shareId}`, { replace: true });
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

  const defaultStatus = initial?.share.status ?? "published";

  return (
    <form
      className="flex flex-col gap-6"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
      }}
      onSubmit={(e) => save(e, defaultStatus)}>
      <div className="flex flex-col gap-3">
        <Link to={isEdit ? `/admin/shares/${initial!.share.id}` : "/admin/shares"} className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> 返回
        </Link>
        <PageHeader
          title={isEdit ? "编辑资料" : "发布新资料"}
          description="整理好资料正文与附件，学员可在「分享资料」中随时查看"
          action={
            <>
              {(!isEdit || initial?.share.status !== "published") && (
                <Button variant="outline" onClick={submitter("draft")} loading={saving === "draft"}>
                  保存草稿
                </Button>
              )}
              <Button type="submit" loading={saving !== null && saving !== "draft"}>
                {isEdit && initial?.share.status !== "draft" ? "保存修改" : "立即发布"}
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
              <Field label="资料标题" htmlFor="title">
                <Input id="title" name="title" required maxLength={100} defaultValue={initial?.share.title} placeholder="例如：前端面试高频手写题整理" />
              </Field>
              <Field label="资料标签" htmlFor="tag-input" hint="输入后按回车添加，可点击下方推荐快速添加">
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
                    placeholder={tags.length ? "" : "面试题, 前端"}
                  />
                </div>
                {suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {suggestions.slice(0, 16).map((s) => (
                      <button key={s} type="button" onClick={() => addTag(s)} className="rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary">
                        + {s}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
              <Field
                label="资料内容"
                htmlFor="description"
                hint="支持 Markdown：标题、列表、粗体、链接、图片、代码块、表格；上传的图片和文件会自动插入到光标位置"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <MarkdownToolbar target={descriptionRef} onChange={changeDescription} onUploadFiles={uploadFromToolbar} disabled={preview} />
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
                      placeholder={"## 资料简介\n\n- 这份资料适合谁\n- 包含哪些内容\n\n**使用建议**：先看文档，再动手练习"}
                    />
                  )}
                </div>
              </Field>
              <Field label="资料附件" hint="可选；支持图片和 7z / tar 压缩包（可上传分卷），上传后自动插入到正文光标位置">
                <FileUploader
                  files={files}
                  scope="share"
                  shareId={initial?.share.id}
                  max={MAX_ATTACHMENTS}
                  onUploaded={(file) => {
                    setFiles((prev) => [...prev, file]);
                    insertShareAttachment(file);
                  }}
                  onRemoved={removeShareAttachment}
                />
                {!initial && files.length > 0 && <p className="mt-1 text-xs text-muted-foreground">发布资料后会自动绑定这些附件。</p>}
              </Field>
            </div>
          </Card>
        </div>

        <Card className={cn("lg:sticky lg:top-8 lg:self-start", wideEdit && "hidden")}>
          <CardHeader title="发布设置" />
          <div className="flex flex-col gap-4 p-5">
            <AudiencePicker
              noun="资料"
              classLabel="可见班级"
              classes={classData?.classes ?? []}
              students={studentData?.students ?? []}
              value={audience}
              onChange={setAudience}
            />

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
              <span>
                <span className="block text-sm font-medium">发布后通知学员</span>
                <span className="block text-xs text-muted-foreground">仅通知当前可见范围内的学员；编辑时只通知新增可见的学员</span>
              </span>
            </label>
          </div>
        </Card>
      </div>
    </form>
  );
}
