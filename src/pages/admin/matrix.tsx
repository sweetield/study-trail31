import { useEffect, useState } from "react";
import { Link } from "react-router";
import useSWR from "swr";
import { ChevronLeft, ChevronRight, Download, GraduationCap, Grid3x3, ListFilter } from "lucide-react";
import type { ClassItem, ProgressStatus } from "@/lib/types";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Button, Card, EmptyState, PageHeader, PageLoader } from "@/components/ui";
import { ExportDialog } from "@/components/export-dialog";
import { MultiSelectFilter } from "@/components/multi-select-filter";

interface MatrixData {
  students: { id: number; name: string; class_id: number | null }[];
  tasks: { id: number; title: string; class_id: number | null; class_ids: number[]; excluded_user_ids: number[] }[];
  taskOptions: { id: number; title: string }[];
  cells: { task_id: number; user_id: number; status: ProgressStatus; percent: number }[];
  studentTotal: number;
  taskTotal: number;
  page: number;
  pageSize: number;
  taskPage: number;
  taskPageSize: number;
}

const CELL_STYLE: Record<ProgressStatus | "todo", string> = {
  todo: "bg-muted text-muted-foreground/60",
  doing: "bg-primary-soft text-primary",
  submitted: "bg-warning-soft text-warning",
  approved: "bg-primary text-primary-foreground",
  rejected: "bg-destructive-soft text-destructive",
};

export default function AdminMatrix() {
  const [classIds, setClassIds] = useState<number[]>([]);
  const [taskIds, setTaskIds] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [taskPage, setTaskPage] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const { data: classData } = useSWR<{ classes: ClassItem[] }>("/api/admin/classes");
  const taskFilterKey = taskIds.join(",");

  useEffect(() => {
    setTaskPage(1);
  }, [taskFilterKey]);

  const params = new URLSearchParams({
    page: String(page),
    pageSize: "30",
    taskPage: String(taskPage),
    taskPageSize: "15",
  });
  if (classIds.length) params.set("class_ids", classIds.join(","));
  if (taskIds.length) params.set("task_ids", taskIds.join(","));
  const { data } = useSWR<MatrixData>(`/api/admin/matrix?${params.toString()}`, { keepPreviousData: true });

  const taskOptions = data?.taskOptions ?? [];
  const filtering = taskIds.length > 0;
  const classOptions = (classData?.classes ?? []).map((c) => ({ id: c.id, title: c.name }));

  const cellMap = new Map((data?.cells ?? []).map((c) => [`${c.user_id}:${c.task_id}`, c]));
  const classNames = new Map((classData?.classes ?? []).map((c) => [c.id, c.name]));
  const eligible = (s: MatrixData["students"][number], t: MatrixData["tasks"][number]) =>
    (!t.class_ids.length || (s.class_id != null && t.class_ids.includes(s.class_id))) && !t.excluded_user_ids.includes(s.id);
  const studentPages = Math.max(1, Math.ceil((data?.studentTotal ?? 0) / (data?.pageSize ?? 30)));
  const taskPages = Math.max(1, Math.ceil((data?.taskTotal ?? 0) / (data?.taskPageSize ?? 15)));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="进度矩阵"
        description="按班级分页查看学员在各任务上的状态，班级与任务均可多选筛选"
        action={
          <>
            <Button variant="outline" onClick={() => setExportOpen(true)} disabled={!taskOptions.length}>
              <Download /> 导出进度
            </Button>
            <MultiSelectFilter
              icon={<ListFilter />}
              label="任务筛选"
              options={taskOptions}
              value={taskIds}
              onChange={setTaskIds}
              searchPlaceholder="搜索任务名称"
              emptyText="暂无已发布任务"
            />
            <MultiSelectFilter
              icon={<GraduationCap />}
              label="班级筛选"
              options={classOptions}
              value={classIds}
              onChange={(next) => {
                setClassIds(next);
                setPage(1);
                setTaskPage(1);
                // 任务范围随班级变化，清空任务筛选避免出现与班级不匹配的空结果
                setTaskIds([]);
              }}
              searchPlaceholder="搜索班级名称"
              emptyText="暂无班级"
            />
          </>
        }
      />

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(CELL_STYLE) as (keyof typeof CELL_STYLE)[]).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn("size-3 rounded-sm", CELL_STYLE[k])} aria-hidden="true" />
            {k === "todo" ? "未开始" : statusMeta(k).label}
          </span>
        ))}
      </div>

      {!data ? (
        <PageLoader />
      ) : !data.students.length || !data.tasks.length ? (
        <Card>
          <EmptyState
            icon={<Grid3x3 />}
            title={filtering && data.students.length ? "没有符合条件的任务" : "暂无数据"}
            description={
              filtering && data.students.length
                ? "当前筛选的任务不在此分页范围内，或已归档；可调整任务筛选或清除筛选后重试"
                : "需要至少一名学员和一个已发布任务"
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 w-24 min-w-24 max-w-24 border-r border-b bg-card px-3 py-3 text-left text-xs font-medium text-muted-foreground">班级</th>
                  <th className="sticky top-0 left-24 z-20 min-w-32 border-r border-b bg-card px-4 py-3 text-left text-xs font-medium text-muted-foreground">学员 / 任务</th>
                  {data.tasks.map((t) => (
                    <th key={t.id} className="sticky top-0 z-10 border-b bg-card px-1 py-3 align-bottom">
                      <Link to={`/admin/tasks/${t.id}`} title={t.title} className="mx-auto block w-20 truncate text-xs font-medium hover:text-primary">
                        {t.title}
                      </Link>
                    </th>
                  ))}
                  <th className="sticky top-0 z-10 border-b border-l bg-card px-3 py-3 text-xs font-medium text-muted-foreground">完成</th>
                </tr>
              </thead>
              <tbody>
                {data.students.map((s) => {
                  const mine = data.tasks.filter((t) => eligible(s, t));
                  const done = mine.filter((t) => cellMap.get(`${s.id}:${t.id}`)?.status === "approved").length;
                  const className = s.class_id != null ? (classNames.get(s.class_id) ?? "") : "未分班";
                  return (
                    <tr key={s.id} className="group">
                      <td className="sticky left-0 z-10 w-24 min-w-24 border-r border-b bg-card px-3 py-1.5 text-xs text-muted-foreground group-hover:bg-muted">
                        <div className="w-[4.5rem] truncate" title={className || undefined}>
                          {className || "—"}
                        </div>
                      </td>
                      <th className="sticky left-24 z-10 min-w-32 border-r border-b bg-card px-4 py-1.5 text-left font-medium group-hover:bg-muted">
                        <Link to={`/admin/students/${s.id}`} className="block max-w-32 truncate hover:text-primary">
                          {s.name}
                        </Link>
                      </th>
                      {data.tasks.map((t) => {
                        if (!eligible(s, t)) return <td key={t.id} className="border-b px-1 py-1.5" aria-label="不适用" />;
                        const cell = cellMap.get(`${s.id}:${t.id}`);
                        const status = cell?.status ?? "todo";
                        return (
                          <td key={t.id} className="border-b px-1 py-1.5 text-center">
                            <span
                              className={cn("mx-auto flex h-7 w-20 items-center justify-center rounded-md text-xs font-medium tabular-nums", CELL_STYLE[status])}
                              title={`${s.name} · ${t.title} · ${status === "todo" ? "未开始" : statusMeta(status).label}`}
                            >
                              {status === "approved" ? "完成" : status === "todo" ? "—" : status === "submitted" ? "待审" : `${cell!.percent}%`}
                            </span>
                          </td>
                        );
                      })}
                      <td className="border-b border-l px-3 py-1.5 text-center text-xs tabular-nums text-muted-foreground">
                        {done}/{mine.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                学员 {data.page} / {studentPages} · 共 {data.studentTotal} 名
              </span>
              <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft /> 上一页
              </Button>
              <Button size="sm" variant="outline" disabled={data.page >= studentPages} onClick={() => setPage((p) => Math.min(studentPages, p + 1))}>
                下一页 <ChevronRight />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                任务 {data.taskPage} / {taskPages} · 共 {data.taskTotal} 个
              </span>
              <Button size="sm" variant="outline" disabled={data.taskPage <= 1} onClick={() => setTaskPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft /> 上一页
              </Button>
              <Button size="sm" variant="outline" disabled={data.taskPage >= taskPages} onClick={() => setTaskPage((p) => Math.min(taskPages, p + 1))}>
                下一页 <ChevronRight />
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        tasks={taskOptions}
        presetIds={taskIds}
        mode="admin"
        classIds={classIds}
      />
    </div>
  );
}
