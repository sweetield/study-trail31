import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import useSWR, { mutate as globalMutate } from "swr";
import { AlarmClock, ArrowLeft, Check, CheckCircle2, ExternalLink, MessageSquareText, PenLine, Pencil, Pin, Send, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import type { FileMeta, Progress, ProgressEvent, Step, StudyLog } from "@/lib/types";
import { ProgressTimeline } from "@/components/progress-timeline";
import { ReadingModeButton, useReadingMode } from "@/components/app-shell";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { statusMeta } from "@/lib/status";
import { cn, dueInfo, formatLogMinutes, formatTime, splitTags } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageLoader, ProgressBar, TechTag, Textarea } from "@/components/ui";
import { FileChips, FileUploader, LazyReplyThread, filesNotReferenced } from "@/components/attachments";
import { Avatar } from "@/components/avatar";
import { Countdown } from "@/components/countdown";
import { LogDialog } from "@/components/log-dialog";
import { TaskLeaderboard, taskLeaderboardKey } from "@/components/task-leaderboard";
import { Markdown } from "@/components/markdown";
import { PriorityBadge } from "@/components/priority-badge";
import { SCORE_LABELS, StarScore } from "@/components/star-rating";

interface Detail {
  task: {
    id: number;
    title: string;
    description: string;
    tech_tags: string;
    due_date: string | null;
    require_review: number;
    priority: number;
    pinned: number;
    created_at: number;
    creator_name?: string | null;
    creator_avatar_id?: string | null;
    urge_due_at?: number | null;
    urge_message?: string | null;
  };
  steps: Step[];
  progress: Progress | null;
  files: FileMeta[];
  task_files?: FileMeta[];
  review_files?: FileMeta[];
  events: ProgressEvent[];
}

interface LogCursor {
  log_date: string;
  id: number;
}

interface TaskLogPage {
  logs: StudyLog[];
  has_more: boolean;
  next: LogCursor | null;
}

export default function StudentTaskDetail() {
  const { id } = useParams();
  const key = `/api/me/tasks/${id}`;
  const logsBase = `/api/me/tasks/${id}/logs`;
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightLogId = Number(searchParams.get("log"));
  const focusParam = Number.isInteger(highlightLogId) && highlightLogId > 0 ? `?log=${highlightLogId}` : "";
  const logsKey = `${logsBase}${focusParam}`;
  const { data, error, mutate } = useSWR<Detail>(key);
  const { data: logPage, mutate: mutateLogs } = useSWR<TaskLogPage>(logsKey);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [editingLog, setEditingLog] = useState<StudyLog | null>(null);
  const [highlightedLog, setHighlightedLog] = useState<number | null>(null);
  const [olderLogs, setOlderLogs] = useState<StudyLog[]>([]);
  const [nextCursor, setNextCursor] = useState<LogCursor | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const logsTopRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollLogsRef = useRef(false);
  const reading = useReadingMode();
  const focus = reading?.focus ?? false;
  useDocumentTitle(data?.task.title);

  // 日志倒序返回：第一页 10 条，更早的点“加载更多”再取
  const logs = [...(logPage?.logs ?? []), ...olderLogs];
  const logsCursor = olderLogs.length ? nextCursor : (logPage?.next ?? null);

  useEffect(() => {
    setOlderLogs([]);
    setNextCursor(null);
  }, [logsKey]);

  useEffect(() => {
    if (!shouldScrollLogsRef.current || !logs.length) return;
    shouldScrollLogsRef.current = false;
    const timer = window.setTimeout(() => {
      logsTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [logs.length]);

  useEffect(() => {
    if (!Number.isInteger(highlightLogId) || highlightLogId <= 0) return;
    if (!logs.some((log) => log.id === highlightLogId)) return;
    setHighlightedLog(highlightLogId);
    const timer = window.setTimeout(() => {
      document.getElementById(`log-${highlightLogId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [logs, highlightLogId]);

  async function loadMoreLogs() {
    if (!logsCursor || loadingLogs) return;
    setLoadingLogs(true);
    try {
      const query = new URLSearchParams({ limit: "10", before_date: logsCursor.log_date, before_id: String(logsCursor.id) });
      const page = await api.get<TaskLogPage>(`${logsBase}?${query}`);
      setOlderLogs((prev) => {
        const seen = new Set([...(logPage?.logs ?? []).map((log) => log.id), ...prev.map((log) => log.id)]);
        return [...prev, ...page.logs.filter((log) => !seen.has(log.id))];
      });
      setNextCursor(page.next);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoadingLogs(false);
    }
  }

  /** 新建打卡时取消通知中的旧日志定位，保存后滚动到日志列表顶部的最新一条 */
  function startNewLog() {
    shouldScrollLogsRef.current = true;
    setHighlightedLog(null);
    setLogOpen(true);
    setEditingLog(null);
    if (searchParams.has("log")) {
      const next = new URLSearchParams(searchParams);
      next.delete("log");
      setSearchParams(next, { replace: true });
    }
  }

  if (error) return <EmptyState title="任务不存在或未发布" action={<Link to="/app/tasks" className="text-sm text-primary hover:underline">返回任务列表</Link>} />;
  if (!data) return <PageLoader />;

  const { task, steps, progress, files = [], task_files: taskFiles = [], review_files: reviewFiles = [], events } = data;
  // 正文里已经内嵌的图片 / 文件不再在下方重复展示
  const extraTaskFiles = filesNotReferenced(taskFiles, task.description);
  const status = progress?.status ?? null;
  const meta = statusMeta(status);
  const locked = status === "submitted" || status === "approved";
  const doneCount = steps.filter((s) => s.done).length;
  const percent = progress?.percent ?? 0;
  const allDone = steps.length === 0 || doneCount === steps.length;
  const due = status === "approved" ? null : dueInfo(task.due_date);
  const refreshLists = () => {
    globalMutate("/api/me/tasks");
    if (id) globalMutate(taskLeaderboardKey(id));
  };

  async function toggleStep(step: Step) {
    if (locked) return;
    const nextDone = !step.done;
    // 基于缓存中的最新数据合并，避免连续快速勾选时后返回的请求覆盖其他步骤的状态
    const applyToggle = (cur: Detail): Detail => {
      const nextSteps = cur.steps.map((s) => (s.id === step.id ? { ...s, done: nextDone } : s));
      const percent = Math.floor((nextSteps.filter((s) => s.done).length * 100) / nextSteps.length);
      const prev = cur.progress ?? ({} as Progress);
      return { ...cur, steps: nextSteps, progress: { ...prev, status: prev.status === "rejected" ? "rejected" : "doing", percent } };
    };
    type StepResult = { progress: { status: Progress["status"]; percent: number } };
    await globalMutate<Detail, StepResult>(key, api.put<StepResult>(`${key}/steps/${step.id}`, { done: nextDone }), {
      optimisticData: (cur) => applyToggle(cur ?? data!),
      populateCache: (res, cur) => {
        const next = applyToggle(cur ?? data!);
        return { ...next, progress: { ...next.progress!, status: res.progress.status } };
      },
      rollbackOnError: true,
      revalidate: false,
    }).catch((e) => toast((e as Error).message, "error"));
    refreshLists();
  }

  async function saveNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy("save");
    try {
      const res = await api.put<{ progress: Progress }>(`${key}/progress`, {
        note: form.get("note"),
        link: form.get("link"),
        percent: steps.length ? undefined : Number(form.get("percent")),
      });
      await mutate({ ...data!, progress: res.progress }, { revalidate: false });
      refreshLists();
      toast("学习记录已保存");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function action(kind: "submit" | "withdraw") {
    setBusy(kind);
    try {
      const res = await api.post<{ progress: Progress }>(`${key}/${kind}`);
      // 立即展示新状态，并重新拉取以更新提交与审核记录
      await mutate({ ...data!, progress: res.progress });
      refreshLists();
      toast(kind === "withdraw" ? "已撤回，可以继续修改" : res.progress.status === "approved" ? "恭喜完成任务" : "已提交，等待辅导员审核");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function addFile(file: FileMeta) {
    await mutate({ ...data!, files: [...files, file] }, { revalidate: false });
  }

  async function removeFile(id: string) {
    await mutate({ ...data!, files: files.filter((file) => file.id !== id) }, { revalidate: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Link to="/app/tasks" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> 我的任务
          </Link>
          <ReadingModeButton />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {!!task.pinned && (
            <Badge tone="primary">
              <Pin className="size-3" /> 置顶
            </Badge>
          )}
          <PriorityBadge priority={task.priority} />
          {due && <Badge tone={due.tone}>{due.label}</Badge>}
          {!task.require_review && <Badge tone="outline">无需审核</Badge>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{task.title}</h1>
        {task.creator_name && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar name={task.creator_name} avatarId={task.creator_avatar_id} className="size-5 text-[10px]" />
            辅导员 {task.creator_name} 发布
          </p>
        )}
        {splitTags(task.tech_tags).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {splitTags(task.tech_tags).map((t) => (
              <TechTag key={t}>{t}</TechTag>
            ))}
          </div>
        )}
      </div>

      {task.urge_due_at && status !== "approved" && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive-soft p-4 text-sm text-destructive">
          <AlarmClock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">
              辅导员督促你尽快完成，剩余时间：<Countdown dueAt={task.urge_due_at} />
            </p>
            {task.urge_message && <Markdown source={task.urge_message} className="text-sm text-destructive/90" />}
          </div>
        </div>
      )}

      {progress && (progress.review_comment || progress.score || reviewFiles.length > 0) && (status === "rejected" || status === "approved") && (
        <div
          className={cn(
            "flex items-start gap-3 rounded-xl border p-4 text-sm",
            status === "rejected" ? "border-destructive/25 bg-destructive-soft text-destructive" : "border-primary/20 bg-primary-soft text-primary",
          )}
        >
          <MessageSquareText className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="flex flex-wrap items-center gap-1.5 font-medium">
              {status === "rejected" ? "辅导员退回意见" : "辅导员评价"}
              {progress.reviewer_name && (
                <span className="flex items-center gap-1 font-normal opacity-90">
                  <Avatar name={progress.reviewer_name} avatarId={progress.reviewer_avatar_id} className="size-5 text-[10px]" />
                  {progress.reviewer_name}
                </span>
              )}
            </p>
            {status === "approved" && progress.score && (
              <p className="flex items-center gap-2">
                <StarScore score={progress.score} />
                <span className="text-xs">{SCORE_LABELS[progress.score]}</span>
              </p>
            )}
            {progress.review_comment && <Markdown source={progress.review_comment} />}
            {reviewFiles.length > 0 && <FileChips files={filesNotReferenced(reviewFiles, progress.review_comment)} className="mt-2" />}
          </div>
        </div>
      )}

      <div className={cn("grid gap-6", focus ? "lg:grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="flex min-w-0 flex-col gap-6">
          {(task.description || extraTaskFiles.length > 0) && (
            <Card>
              <CardHeader title="任务说明" />
              {task.description && <Markdown source={task.description} className="reading-body px-5 py-4 lg:px-6 lg:py-5" toc />}
              {extraTaskFiles.length > 0 && <FileChips files={extraTaskFiles} className="px-5 pb-4 lg:px-6" />}
            </Card>
          )}

          {steps.length > 0 && (
            <Card>
              <CardHeader title="学习步骤" description={`已完成 ${doneCount} / ${steps.length}，勾选后自动保存`} />
              <ul className="flex flex-col p-2">
                {steps.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => toggleStep(s)}
                      disabled={locked}
                      aria-pressed={!!s.done}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <span
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
                          s.done ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card",
                        )}
                      >
                        {s.done && <Check className="size-4" strokeWidth={3} />}
                      </span>
                      <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                      <span className={cn("text-sm", s.done && "text-muted-foreground line-through")}>{s.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <LogDialog
            inline
            open={logOpen}
            onClose={() => setLogOpen(false)}
            tasks={[{ id: task.id, title: task.title }]}
            defaultTaskId={task.id}
            onSaved={() => {
              setOlderLogs([]);
              setNextCursor(null);
              void mutateLogs();
              refreshLists();
            }}
          />
          {editingLog && (
            <LogDialog
              key={editingLog.id}
              inline
              open={!!editingLog}
              onClose={() => setEditingLog(null)}
              tasks={[{ id: task.id, title: task.title }]}
              editing={editingLog}
              onSaved={() => {
                setEditingLog(null);
                setOlderLogs([]);
                setNextCursor(null);
                void mutate();
                void mutateLogs();
                refreshLists();
              }}
            />
          )}

          <Card className="order-last lg:order-none">
            <CardHeader
              title="本任务学习日志"
              description={`已加载 ${logs.length} 条 · ${formatLogMinutes(logs.reduce((s, l) => s + l.minutes, 0))}（按时间倒序）`}
              action={
                <Button size="sm" variant="outline" onClick={startNewLog}>
                  <PenLine /> 打卡
                </Button>
              }
            />
            <div ref={logsTopRef} />
            {logs.length ? (
              <>
                <ul className="divide-y">
                  {logs.map((l) => (
                    <li
                      key={l.id}
                      id={`log-${l.id}`}
                      className={cn(
                        "group flex scroll-mt-24 gap-4 px-5 py-3 transition-colors",
                        highlightedLog === l.id && "bg-warning-soft/60 ring-1 ring-warning/40 ring-inset",
                      )}
                    >
                      <div className="w-20 shrink-0 text-xs text-muted-foreground">
                        <p>{l.log_date}</p>
                        <p className="mt-0.5 tabular-nums">{formatLogMinutes(l.minutes)}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <Markdown source={l.content} className="reading-body" />
                        {filesNotReferenced(l.files, l.content).length > 0 && (
                          <FileChips files={filesNotReferenced(l.files, l.content)} className="mt-2" />
                        )}
                        <LazyReplyThread logId={l.id} hasReplies={l.has_replies} />
                      </div>
                      {l.editable && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { setEditingLog(l); setLogOpen(false); }}
                          className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label="编辑这条学习日志"
                          title="编辑这条学习日志"
                        >
                          <Pencil />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {logsCursor && (
                  <div className="flex justify-center border-t px-5 py-3">
                    <Button variant="outline" size="sm" onClick={loadMoreLogs} loading={loadingLogs}>
                      加载更早的日志
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="还没有日志" description="学习时随手记录，方便复盘和老师了解你的情况" />
            )}
          </Card>
        </div>

        <aside className={cn("flex min-w-0 flex-col gap-6 lg:sticky lg:top-8 lg:self-start", focus && "hidden")}>
          <Card>
            <div className="flex flex-col gap-3 border-b p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">完成进度</span>
                <span className="text-3xl font-semibold tabular-nums">{percent}%</span>
              </div>
              <ProgressBar value={percent} tone={status === "submitted" ? "warning" : "primary"} />
              {progress?.updated_at && <p className="text-xs text-muted-foreground">最近更新：{formatTime(progress.updated_at)}</p>}
            </div>

            <form onSubmit={saveNote} className="flex flex-col gap-4 p-5" key={`${status}:${progress?.note ?? ""}:${progress?.link ?? ""}`}>
              {steps.length === 0 && (
                <Field label="手动填写进度" htmlFor="percent">
                  <div className="flex items-center gap-3">
                    <input
                      id="percent"
                      name="percent"
                      type="range"
                      min={0}
                      max={100}
                      step={10}
                      defaultValue={percent}
                      disabled={locked}
                      className="flex-1 accent-primary"
                    />
                  </div>
                </Field>
              )}
              <Field label="学习笔记 / 遇到的问题" htmlFor="note">
                <Textarea id="note" name="note" defaultValue={progress?.note ?? ""} disabled={locked} maxLength={2000} placeholder="记录心得、难点，辅导员审核时可以看到" />
              </Field>
              <Field label="作品 / 代码链接" htmlFor="link" hint="如 GitHub 仓库、在线演示地址">
                <Input id="link" name="link" type="url" defaultValue={progress?.link ?? ""} disabled={locked} placeholder="https://" />
              </Field>
              {locked && progress?.link && (
                <a href={progress.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-primary hover:underline">
                  <ExternalLink className="size-3.5" /> 打开链接
                </a>
              )}
              {(!locked || files.length > 0) && (
                <Field label="作品附件" hint={locked ? undefined : "图片或 7z / tar 压缩包（可分卷），单个 ≤ 20 MB"}>
                  <FileUploader files={files} scope="progress" taskId={task.id} disabled={locked} onUploaded={addFile} onRemoved={removeFile} />
                </Field>
              )}

              {status === "approved" ? (
                <p className="flex items-center gap-2 rounded-lg bg-primary-soft px-3 py-2.5 text-sm font-medium text-primary">
                  <CheckCircle2 className="size-4" /> 任务已完成
                </p>
              ) : status === "submitted" ? (
                <div className="flex flex-col gap-2">
                  <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">已提交，等待辅导员审核</p>
                  <Button variant="outline" onClick={() => action("withdraw")} loading={busy === "withdraw"}>
                    <Undo2 /> 撤回修改
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Button type="submit" variant="outline" loading={busy === "save"}>
                    保存记录
                  </Button>
                  <Button onClick={() => action("submit")} loading={busy === "submit"} disabled={!allDone}>
                    <Send /> {task.require_review ? "提交审核" : "标记完成"}
                  </Button>
                  {!allDone && <p className="text-center text-xs text-muted-foreground">完成全部 {steps.length} 个步骤后可提交</p>}
                </div>
              )}
            </form>
          </Card>
          <TaskLeaderboard taskId={task.id} />
          {events.length > 0 && (
            <Card>
              <CardHeader title="提交与审核记录" description={`共 ${events.length} 条`} />
              <ProgressTimeline events={events} className="max-h-96 overflow-y-auto p-5" />
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
