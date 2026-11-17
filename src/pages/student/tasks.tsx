import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Download, ListChecks, SearchX, X } from "lucide-react";
import type { StudentTask } from "@/lib/types";
import { useFilteredTasks, useQueryParam, useTaskFilters, useViewMode } from "@/hooks/use-task-list";
import { Button, Card, EmptyState, PageHeader, PageLoader, SegmentedTabs } from "@/components/ui";
import { StudentTaskCard, StudentTaskListHeader, StudentTaskRow } from "@/components/student-task-card";
import { TaskGroups } from "@/components/task-groups";
import { TaskToolbar, ViewToggle } from "@/components/task-toolbar";
import { ExportDialog } from "@/components/export-dialog";

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "todo", label: "未开始" },
  { key: "doing", label: "进行中" },
  { key: "submitted", label: "待审核" },
  { key: "approved", label: "已完成" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matches(t: StudentTask, f: FilterKey) {
  if (f === "all") return true;
  if (f === "todo") return !t.status;
  if (f === "doing") return t.status === "doing" || t.status === "rejected";
  return t.status === f;
}

const NO_TASKS: StudentTask[] = [];
const searchFields = (t: StudentTask) => [t.title, t.tech_tags];

export default function StudentTasks() {
  const { data } = useSWR<{ tasks: StudentTask[] }>("/api/me/tasks");
  const [status, setStatus] = useQueryParam<FilterKey>("status", FILTERS, "all");
  const [filters, setFilters] = useTaskFilters();
  const [view, setView] = useViewMode("student-tasks", "grid");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreset, setExportPreset] = useState<number[] | undefined>(undefined);
  const anchorRef = useRef<number | null>(null);

  const all = data?.tasks ?? NO_TASKS;
  const inTab = useMemo(() => all.filter((t) => matches(t, status)), [all, status]);
  const { groups, techs, dueCounts, total } = useFilteredTasks(inTab, filters, searchFields);

  // 分组时同一任务可能在多个技术标签分组里重复，这里按显示顺序去重，供 Shift 连选使用
  const ordered = useMemo(() => {
    const map = new Map<number, StudentTask>();
    for (const group of groups) for (const task of group.items) if (!map.has(task.id)) map.set(task.id, task);
    return [...map.values()];
  }, [groups]);

  const filterKey = [status, filters.q, filters.tech, filters.due, filters.sort, filters.group].join("|");
  useEffect(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, [filterKey]);

  const allChecked = ordered.length > 0 && ordered.every((t) => selected.has(t.id));

  function toggleSelect(id: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    const index = ordered.findIndex((t) => t.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && anchorRef.current != null) {
        const anchorIndex = ordered.findIndex((t) => t.id === anchorRef.current);
        if (anchorIndex >= 0 && index >= 0) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          for (let i = start; i <= end; i++) next.add(ordered[i].id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(ordered.map((t) => t.id)));
    anchorRef.current = null;
  }

  function openExport(preset?: number[]) {
    // 没有显式传入 id 时，若列表里已勾选任务，则只导出勾选项
    setExportPreset(preset ?? (selected.size ? [...selected] : undefined));
    setExportOpen(true);
  }

  if (!data) return <PageLoader />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="我的任务"
        description="点击任务进入详情，勾选步骤即可自动更新进度"
        action={
          <Button variant="outline" onClick={() => openExport()} disabled={!all.length}>
            <Download /> 导出进度
          </Button>
        }
      />

      <div className="flex items-center justify-between gap-3">
        <SegmentedTabs label="任务状态筛选" options={FILTERS.map((f) => ({ ...f, count: all.filter((t) => matches(t, f.key)).length }))} value={status} onChange={setStatus} />
        <div className="flex items-center gap-3">
          {total > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground" title="选择全部筛选结果">
              <input type="checkbox" className="size-4 accent-primary" checked={allChecked} onChange={toggleAll} aria-label="选择全部筛选结果" />
              全选
            </label>
          )}
          <span className="hidden text-sm text-muted-foreground sm:inline" aria-live="polite">
            共 {total} 个任务
          </span>
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-primary-soft/40 px-4 py-3">
          <span className="mr-1 text-sm font-medium">已选 {selected.size} 个任务</span>
          <Button size="sm" variant="outline" onClick={() => openExport([...selected])}>
            <Download /> 导出
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="ml-auto">
            <X /> 取消选择
          </Button>
        </div>
      )}

      {all.length === 0 ? (
        <Card>
          <EmptyState icon={<ListChecks />} title="暂无学习任务" description="辅导员发布任务后会显示在这里" />
        </Card>
      ) : (
        <>
          <TaskToolbar filters={filters} onChange={setFilters} techs={techs} dueCounts={dueCounts} placeholder="搜索任务名称或技术" />
          {total === 0 ? (
            <Card>
              <EmptyState icon={<SearchX />} title="没有符合条件的任务" description="试试切换状态，或调整关键词、学习技术、日期条件" />
            </Card>
          ) : (
            <TaskGroups
              groups={groups}
              view={view}
              getKey={(t) => t.id}
              renderCard={(t) => (
                <StudentTaskCard task={t} selectable selected={selected.has(t.id)} onToggleSelect={(e) => toggleSelect(t.id, e)} />
              )}
              renderRow={(t) => (
                <StudentTaskRow task={t} selectable selected={selected.has(t.id)} onToggleSelect={(e) => toggleSelect(t.id, e)} />
              )}
              listHeader={<StudentTaskListHeader selectable allSelected={allChecked} onToggleAll={toggleAll} />}
            />
          )}
        </>
      )}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} tasks={all} mode="student" presetIds={exportPreset} />
    </div>
  );
}
