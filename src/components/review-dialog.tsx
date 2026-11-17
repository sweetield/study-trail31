import { useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import type { FileMeta, ProgressEvent } from "@/lib/types";
import { ProgressTimeline } from "./progress-timeline";
import { Check, ExternalLink, Eye, PenLine, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import { useToast } from "./toast";
import { StarRating } from "./star-rating";
import {
  FileChips,
  FileUploader,
  MAX_ATTACHMENTS,
  buildAttachmentInsertion,
  stripFileMarkdown,
  uploadAttachmentFiles,
} from "./attachments";
import { Markdown } from "./markdown";
import { MarkdownToolbar } from "./markdown-toolbar";
import { Button, Dialog, Field, Textarea } from "./ui";

export interface ReviewTarget {
  task_id: number;
  user_id: number;
  user_name: string;
  task_title: string;
  note: string | null;
  link: string | null;
  submitted_at: number | null;
}

type ReviewAction = "approve" | "reject";

export async function submitReview(
  items: { task_id: number; user_id: number }[],
  action: ReviewAction,
  comment: string,
  score: number | null,
  fileIds: string[] = [],
) {
  const res = await api.post<{ updated: number }>("/api/admin/reviews", {
    items,
    action,
    comment,
    score: action === "approve" ? score : null,
    file_ids: items.length === 1 ? fileIds : [],
  });
  await mutate((key) => typeof key === "string" && key.startsWith("/api/admin/"));
  return res.updated;
}

export function ReviewDialog({ target, onClose }: { target: ReviewTarget | null; onClose: () => void }) {
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const commentRef = useRef(comment);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { data: eventData } = useSWR<{ events: ProgressEvent[] }>(
    target ? `/api/admin/progress/${target.task_id}/${target.user_id}/events` : null,
  );
  const { data: fileData, mutate: mutateFiles } = useSWR<{ files: FileMeta[]; reviewFiles: FileMeta[] }>(
    target ? `/api/admin/progress/${target.task_id}/${target.user_id}/files` : null,
  );
  // 第一条是本次提交，其余为此前的提交与审核往来
  const history = eventData?.events.slice(1) ?? [];
  const reviewFiles = fileData?.reviewFiles ?? [];

  async function removeFile(id: string) {
    if (!confirm("确定删除这个作品附件吗？删除后无法恢复。")) return;
    try {
      await api.del(`/api/files/${id}`);
      await mutateFiles();
      await mutate((key) => typeof key === "string" && key.startsWith("/api/admin/"));
      toast("附件已删除");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  function changeComment(next: string) {
    commentRef.current = next;
    setComment(next);
  }

  /** 上传后把图片 / 文件插入评语的光标位置，形成图文批注 */
  function insertCommentAttachment(file: FileMeta, at?: number) {
    const el = textareaRef.current;
    const value = commentRef.current;
    const start = at ?? (el ? el.selectionStart : value.length);
    const end = at ?? (el ? el.selectionEnd : value.length);
    const next = buildAttachmentInsertion(value, start, end, file);
    changeComment(next.value);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
    return next.caret;
  }

  async function uploadFromToolbar(selected: File[], selection: { start: number; end: number }) {
    if (!target) return;
    let caret: number | null = selection.start;
    await uploadAttachmentFiles({
      files: selected,
      scope: "review",
      taskId: target.task_id,
      ownerUserId: target.user_id,
      max: MAX_ATTACHMENTS,
      current: files.length,
      onUploaded: (file) => {
        setFiles((prev) => [...prev, file]);
        caret = insertCommentAttachment(file, caret ?? undefined);
      },
      notify: toast,
    });
  }

  function removeDraftFile(id: string) {
    setFiles((prev) => prev.filter((file) => file.id !== id));
    changeComment(stripFileMarkdown(commentRef.current, id));
  }

  function close() {
    setComment("");
    commentRef.current = "";
    setScore(null);
    setFiles([]);
    setPreview(false);
    onClose();
  }

  async function run(action: ReviewAction) {
    if (!target) return;
    setBusy(action);
    try {
      await submitReview([{ task_id: target.task_id, user_id: target.user_id }], action, comment, score, files.map((file) => file.id));
      toast(action === "approve" ? `已通过 ${target.user_name} 的提交` : `已退回给 ${target.user_name}`);
      close();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={!!target} onClose={close} title={`审核：${target?.user_name ?? ""}`} description={target?.task_title} className="max-w-3xl">
      {target && (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <p className="mb-1 text-xs text-muted-foreground">学员笔记 · 提交于 {formatTime(target.submitted_at)}</p>
            <p className="leading-relaxed whitespace-pre-wrap">{target.note || "（未填写）"}</p>
            {target.link && (
              <a href={target.link} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1 break-all text-primary hover:underline">
                <ExternalLink className="size-3.5 shrink-0" /> {target.link}
              </a>
            )}
          </div>
          {!!fileData?.files.length && (
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-xs text-muted-foreground">作品附件（{fileData.files.length}）· 可删除不合规文件</p>
              <FileChips files={fileData.files} onRemove={removeFile} />
            </div>
          )}
          {!!reviewFiles.length && (
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-xs text-muted-foreground">历史批注附件（{reviewFiles.length}）</p>
              <FileChips files={reviewFiles} />
            </div>
          )}
          {history.length > 0 && (
            <details className="group rounded-lg border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground select-none">
                历史记录（{history.length} 条）
              </summary>
              <ProgressTimeline events={history} className="mt-3" />
            </details>
          )}
          <Field label="辅导员评分" hint="审核通过时生效，再次点击同一颗星可取消">
            <StarRating value={score} onChange={setScore} label="辅导员评分" />
          </Field>
          <Field
            label="辅导员评语 / 退回原因"
            htmlFor="review-comment"
            hint="退回时必填，学员会在任务页看到；支持 Markdown 和颜色写法"
          >
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <MarkdownToolbar target={textareaRef} onChange={changeComment} onUploadFiles={uploadFromToolbar} disabled={preview} />
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
                <div className="min-h-32 rounded-lg border bg-card px-3 py-2">
                  {comment.trim() ? <Markdown source={comment} /> : <p className="text-sm text-muted-foreground">还没有评语</p>}
                </div>
              ) : (
                <Textarea
                  id="review-comment"
                  ref={textareaRef}
                  value={comment}
                  onChange={(e) => changeComment(e.target.value)}
                  maxLength={5000}
                  rows={8}
                  className="min-h-32 font-mono text-[13px] leading-relaxed"
                  placeholder={"做得很好！\n\n**建议**：补充 README，并用 <font color=\"red\">红色</font> 标出重点。"}
                />
              )}
            </div>
          </Field>
          <Field label="批注附件" hint="支持图片和 7z / tar 压缩包；可在上方工具栏直接插入，也可以在这里上传，学员在任务页可以看到并下载">
            <FileUploader
              files={files}
              scope="review"
              taskId={target.task_id}
              ownerUserId={target.user_id}
              max={MAX_ATTACHMENTS}
              onUploaded={(file) => setFiles((prev) => [...prev, file])}
              onRemoved={removeDraftFile}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => run("reject")} loading={busy === "reject"} className="text-destructive">
              <Undo2 /> 退回修改
            </Button>
            <Button onClick={() => run("approve")} loading={busy === "approve"}>
              <Check /> 审核通过
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
