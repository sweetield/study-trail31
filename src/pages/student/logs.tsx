import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "react-router";
import { Lock, NotebookPen, PenLine, Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { StudentTask, StudyLog } from "@/lib/types";
import { cn, formatLogMinutes, formatMinutes } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, PageLoader, StatCard } from "@/components/ui";
import { StudyChart, computeStreak, type DailyRow } from "@/components/study-chart";
import { FileChips, LazyReplyThread, filesNotReferenced } from "@/components/attachments";
import { LogDialog } from "@/components/log-dialog";
import { Markdown } from "@/components/markdown";

type TaskFilter = "all" | "none" | number;
type Cursor = { log_date: string; id: number };
interface LogPage {
  logs: StudyLog[];
  daily: DailyRow[];
  has_more: boolean;
  next: Cursor | null;
  facets?: { task_id: number | null; count: number; title: string | null }[];
}

const PAGE_SIZE = 10;

export default function StudentLogs() {
  const [params, setParams] = useSearchParams();
  const highlightId = Number(params.get("log"));
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  // 服务端只返回最近 10 条，更早的日志点“加载更多”再取；留言点开某条日志时才加载
  const filterParam = taskFilter === "all" ? "" : `&task_id=${taskFilter}`;
  const focusParam = Number.isInteger(highlightId) && highlightId > 0 ? `&log=${highlightId}` : "";
  const key = `/api/me/logs?limit=${PAGE_SIZE}&with_facets=1${filterParam}${focusParam}`;
  const { data, mutate } = useSWR<LogPage>(key, { keepPreviousData: true });
  const { data: taskData } = useSWR<{ tasks: StudentTask[] }>("/api/me/tasks");
  const [olderLogs, setOlderLogs] = useState<StudyLog[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StudyLog | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const toast = useToast();
  const latestRef = useRef<HTMLDivElement>(null);

  // 切换筛选条件时回到第一页
  useEffect(() => {
    setOlderLogs([]);
    setNextCursor(null);
  }, [key]);

  // 任务日志被删光后，该筛选项会从 facets 消失，自动回到“全部”
  useEffect(() => {
    if (typeof taskFilter !== "number" || !data?.facets) return;
    if (!data.facets.some((f) => f.task_id === taskFilter)) setTaskFilter("all");
  }, [data?.facets, taskFilter]);

  const logs = [...(data?.logs ?? []), ...olderLogs];
  const cursor = olderLogs.length ? nextCursor : (data?.next ?? null);

  useEffect(() => {
    if (!logs.length || !Number.isInteger(highlightId) || highlightId <= 0) return;
    const log = logs.find((item) => item.id === highlightId);
    if (!log) return;
    if (taskFilter !== "all") {
      setTaskFilter("all");
      return;
    }
    setHighlighted(highlightId);
    const timer = window.setTimeout(() => {
      document.getElementById(`log-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [logs, highlightId, taskFilter]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), before_date: cursor.log_date, before_id: String(cursor.id) });
      if (typeof taskFilter === "number") query.set("task_id", String(taskFilter));
      else if (taskFilter === "none") query.set("task_id", "none");
      const page = await api.get<LogPage>(`/api/me/logs?${query}`);
      const firstIds = new Set((data?.logs ?? []).map((l) => l.id));
      setOlderLogs((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...page.logs.filter((l) => !seen.has(l.id) && !firstIds.has(l.id))];
      });
      setNextCursor(page.next);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoadingMore(false);
    }
  }

  /** 学员日志页按最新优先排列，打卡保存后自动滚动到列表顶部的最新日志 */
  function scrollToLatest() {
    setHighlighted(null);
    setOlderLogs([]);
    setNextCursor(null);
    // 取消通知带来的旧日志定位，避免保存后又被拉回旧日志
    if (params.has("log")) {
      const next = new URLSearchParams(params);
      next.delete("log");
      setParams(next, { replace: true });
    }
    window.setTimeout(() => latestRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }

  if (!data) return <PageLoader />;

  const facets = data.facets ?? [];
  const filters: { key: TaskFilter; label: string; count: number }[] = [
    { key: "all", label: "全部", count: facets.reduce((s, f) => s + f.count, 0) },
    ...facets
      .filter((f) => f.task_id != null)
      .map((f) => ({ key: f.task_id!, label: f.title ?? `任务 #${f.task_id}`, count: f.count })),
    ...(facets.some((f) => f.task_id == null) ? [{ key: "none" as const, label: "未关联任务", count: facets.find((f) => f.task_id == null)!.count }] : []),
  ];
  const activeFilter: TaskFilter = typeof taskFilter === "number" && !facets.some((f) => f.task_id === taskFilter) ? "all" : taskFilter;
  const filteredLogs = logs.filter((l) =>
    activeFilter === "all" ? true : activeFilter === "none" ? l.task_id == null : l.task_id === activeFilter,
  );

  const groups = new Map<string, StudyLog[]>();
  for (const l of filteredLogs) groups.set(l.log_date, [...(groups.get(l.log_date) ?? []), l]);
  const total = (data.daily ?? []).reduce((s, d) => s + d.minutes, 0);

  async function remove(id: number) {
    if (!confirm("确定删除这条日志吗？")) return;
    try {
      await api.del(`/api/me/logs/${id}`);
      setOlderLogs([]);
      setNextCursor(null);
      await mutate();
      toast("日志已删除");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="学习日志"
        description="每天记录一点点，见证自己的成长"
        action={
          <Button onClick={() => { setOpen(true); setEditing(null); }}>
            <PenLine /> 学习打卡
          </Button>
        }
      />

      <LogDialog inline open={open} onClose={() => setOpen(false)} tasks={(taskData?.tasks ?? []).filter((t) => t.status !== "approved")} onSaved={scrollToLatest} />
      <LogDialog
        key={editing?.id ?? "none"}
        inline
        open={!!editing}
        onClose={() => setEditing(null)}
        tasks={taskData?.tasks ?? []}
        editing={editing}
        onSaved={() => { setOlderLogs([]); setNextCursor(null); void mutate(); }}
      />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="累计时长" value={formatMinutes(total)} />
        <StatCard label="打卡天数" value={`${data.daily.length} 天`} />
        <StatCard label="连续打卡" value={`${computeStreak(data.daily)} 天`} />
      </div>

      <Card>
        <CardHeader title="最近 30 天" />
        <div className="overflow-x-auto px-5 pt-6 pb-4">
          <div className="min-w-[560px]">
            <StudyChart daily={data.daily} days={30} />
          </div>
        </div>
      </Card>

      {filters.length > 2 && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1 self-start overflow-x-auto rounded-lg bg-muted p-1 max-w-full" role="tablist" aria-label="按任务筛选日志">
            {filters.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={activeFilter === f.key}
                onClick={() => setTaskFilter(f.key)}
                className={cn(
                  "flex max-w-48 shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors",
                  activeFilter === f.key && "bg-card font-medium text-foreground shadow-sm",
                )}
              >
                <span className="truncate">{f.label}</span>
                <span className="text-xs tabular-nums opacity-70">{f.count}</span>
              </button>
            ))}
          </div>
          {activeFilter !== "all" && (
            <p className="text-xs text-muted-foreground">
              已加载 {filteredLogs.length} 条 · {formatMinutes(filteredLogs.reduce((s, l) => s + l.minutes, 0))}
            </p>
          )}
        </div>
      )}

      <div ref={latestRef} className="scroll-mt-24" aria-hidden="true" />
      {groups.size ? (
        <div className="flex flex-col gap-5">
          {[...groups].map(([date, logs]) => (
            <section key={date} aria-label={date}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
                {date}
                <span className="text-xs font-normal text-muted-foreground">{formatMinutes(logs.reduce((s, l) => s + l.minutes, 0))}</span>
              </h2>
              <Card className="divide-y">
                {logs.map((l) => (
                  <div
                    key={l.id}
                    id={`log-${l.id}`}
                    className={cn(
                      "group flex scroll-mt-24 items-start gap-4 px-5 py-3.5 transition-colors",
                      highlighted === l.id && "bg-warning-soft/60 ring-1 ring-warning/40 ring-inset",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium tabular-nums text-primary">{formatLogMinutes(l.minutes)}</span>
                        {l.task_title && activeFilter === "all" && <Badge tone="outline">{l.task_title}</Badge>}
                      </div>
                      <Markdown source={l.content} />
                      {filesNotReferenced(l.files, l.content).length > 0 && (
                        <FileChips files={filesNotReferenced(l.files, l.content)} className="mt-2" />
                      )}
                      <LazyReplyThread logId={l.id} hasReplies={l.has_replies} />
                    </div>
                    {l.editable === false ? (
                      <span
                        className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                        title="已有辅导员留言或产生了更新的学习日志，这条日志不能再修改"
                      >
                        <Lock className="size-3.5" aria-hidden="true" /> 已锁定
                      </span>
                    ) : (
                      <div className="flex shrink-0 gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button variant="ghost" size="icon" onClick={() => { setEditing(l); setOpen(false); }} aria-label="编辑日志">
                          <Pencil />
                        </Button>
                        <Button variant="destructive-ghost" size="icon" onClick={() => remove(l.id)} aria-label="删除日志">
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </Card>
            </section>
          ))}
          {cursor && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={loadMore} loading={loadingMore}>
                加载更早的日志
              </Button>
            </div>
          )}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<NotebookPen />} title={activeFilter === "all" ? "还没有学习日志" : "这个筛选下暂无日志"} description={activeFilter === "all" ? "点击右上角“学习打卡”记录第一条" : "切换到其他任务或查看全部"} />
        </Card>
      )}
    </div>
  );
}
