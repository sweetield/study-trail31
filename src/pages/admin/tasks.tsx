import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import useSWR from "swr";
import { Archive, Download, ListTodo, Plus, SearchX, Tag, Tags, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { AdminTask } from "@/lib/types";
import { TASK_STATUS_LABEL } from "@/lib/status";
import { useFilteredTasks, useQueryParam, useTaskFilters, useViewMode } from "@/hooks/use-task-list";
import { Button, buttonVariants, Card, Dialog, EmptyState, Field, Input, PageHeader, PageLoader, SegmentedTabs } from "@/components/ui";
import { AdminTaskCard, AdminTaskListHeader, AdminTaskRow } from "@/components/admin-task-item";
import { TaskGroups } from "@/components/task-groups";
import { TaskToolbar, ViewToggle } from "@/components/task-toolbar";
import { ExportDialog } from "@/components/export-dialog";
import { useToast } from "@/components/toast";

const TABS = (["published", "draft", "archived"] as const).map((key) => ({ key, label: TASK_STATUS_LABEL[key] }));

const NO_TASKS: AdminTask[] = [];
const searchFields = (t: AdminTask) => [t.title, t.tech_tags, t.class_name, t.class_names];

export default function AdminTasks() {
  const toast = useToast();
  const { data, mutate: reload } = useSWR<{ tasks: AdminTask[] }>("/api/admin/tasks");
  const [tab, setTab] = useQueryParam<AdminTask["status"]>("status", TABS, "published");
  const [filters, setFilters] = useTaskFilters();
  const [view, setView] = useViewMode("admin-tasks", "list");
  const [exportOpen, setExportOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagMode, setTagMode] = useState<"add" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<number | null>(null);

  const all = data?.tasks ?? NO_TASKS;
  const inTab = useMemo(() => all.filter((t) => t.status === tab), [all, tab]);
  const { groups, techs, dueCounts, total } = useFilteredTasks(inTab, filters, searchFields);

  // 分组时同一任务可能在多个技术标签分组里重复，这里按显示顺序去重，供 Shift 连选使用
  const ordered = useMemo(() => {
    const map = new Map<number, AdminTask>();
    for (const group of groups) for (const task of group.items) if (!map.has(task.id)) map.set(task.id, task);
    return [...map.values()];
  }, [groups]);

  const filterKey = [tab, filters.q, filters.tech, filters.due, filters.sort, filters.group].join("|");

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

  async function batchUpdate(payload: { status?: AdminTask["status"]; add_tags?: string; remove_tags?: string }, message: string) {
    setBusy(true);
    try {
      await api.post("/api/admin/tasks/batch-update", { ids: [...selected], ...payload });
      await reload();
      setSelected(new Set());
      setTagMode(null);
      toast(message);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(task: AdminTask) {
    try {
      await api.post(`/api/admin/tasks/${task.id}/pin`, { pinned: !task.pinned });
      await reload();
      toast(task.pinned ? "已取消置顶" : "已置顶，置顶任务会排在学员任务列表最前");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function batchDelete() {
    if (!confirm(`确定删除选中的 ${selected.size} 个任务吗？相关学习进度、提交附件与审核记录都会被永久删除。若只是暂时不用，建议改用归档。`)) return;
    setBusy(true);
    try {
      await api.post("/api/admin/tasks/batch-delete", { ids: [...selected] });
      await reload();
      setSelected(new Set());
      toast("已删除所选任务");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <PageLoader />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="学习任务"
        description="发布任务、拆分学习步骤，学员勾选后自动计算进度"
        action={
          <>
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <Download /> 导出进度
            </Button>
            <Link to="/admin/tasks/new" className={buttonVariants()}>
              <Plus /> 发布任务
            </Link>
          </>
        }
      />

      <div className="flex items-center justify-between gap-3">
        <SegmentedTabs label="任务状态" options={TABS.map((t) => ({ ...t, count: all.filter((x) => x.status === t.key).length }))} value={tab} onChange={setTab} />
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
          <Button size="sm" variant="outline" onClick={() => batchUpdate({ status: "archived" }, "已归档所选任务")} disabled={busy || tab === "archived"}>
            <Archive /> 归档
          </Button>
          <Button size="sm" variant="outline" onClick={() => setTagMode("add")} disabled={busy}>
            <Tags /> 添加标签
          </Button>
          <Button size="sm" variant="outline" onClick={() => setTagMode("remove")} disabled={busy}>
            <Tag /> 移除标签
          </Button>
          <Button size="sm" variant="destructive-ghost" onClick={batchDelete} disabled={busy}>
            <Trash2 /> 批量删除
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={busy} className="ml-auto">
            <X /> 取消选择
          </Button>
        </div>
      )}

      {inTab.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListTodo />}
            title={`暂无${TASK_STATUS_LABEL[tab]}任务`}
            action={
              tab === "published" ? (
                <Link to="/admin/tasks/new" className="text-sm text-primary hover:underline">
                  立即发布
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <TaskToolbar filters={filters} onChange={setFilters} techs={techs} dueCounts={dueCounts} placeholder="搜索任务名称、技术或班级" />
          {total === 0 ? (
            <Card>
              <EmptyState icon={<SearchX />} title="没有符合条件的任务" description="试试调整关键词、学习技术或日期条件" />
            </Card>
          ) : (
            <TaskGroups
              groups={groups}
              view={view}
              getKey={(t) => t.id}
              renderCard={(t) => (
                <AdminTaskCard task={t} selectable selected={selected.has(t.id)} onToggleSelect={(e) => toggleSelect(t.id, e)} onPin={() => togglePin(t)} />
              )}
              renderRow={(t) => (
                <AdminTaskRow task={t} selectable selected={selected.has(t.id)} onToggleSelect={(e) => toggleSelect(t.id, e)} onPin={() => togglePin(t)} />
              )}
              listHeader={<AdminTaskListHeader selectable allSelected={allChecked} onToggleAll={toggleAll} />}
            />
          )}
        </>
      )}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} tasks={all} mode="admin" presetIds={[...selected]} />

      <TaskTagDialog
        key={tagMode ?? "closed"}
        mode={tagMode}
        count={selected.size}
        loading={busy}
        onClose={() => setTagMode(null)}
        onApply={(tags) => batchUpdate(tagMode === "remove" ? { remove_tags: tags } : { add_tags: tags }, tagMode === "remove" ? "已移除所选任务的标签" : "已为所选任务添加标签")}
      />
    </div>
  );
}

function TaskTagDialog({
  mode,
  count,
  loading,
  onClose,
  onApply,
}: {
  mode: "add" | "remove" | null;
  count: number;
  loading: boolean;
  onClose: () => void;
  onApply: (tags: string) => void;
}) {
  const [tags, setTags] = useState("");
  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      title={mode === "remove" ? "批量移除标签" : "批量添加标签"}
      description={`将${mode === "remove" ? "移除" : "添加"}的标签应用到选中的 ${count} 个任务`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (tags.trim()) onApply(tags);
        }}
        className="flex flex-col gap-4"
      >
        <Field label="技术标签" htmlFor="batch-task-tags" hint="多个标签用空格、逗号或中文逗号分隔；单个标签不超过 24 个字符">
          <Input
            id="batch-task-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            required
            autoFocus
            placeholder={mode === "remove" ? "例如：React Vue" : "例如：React TypeScript"}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button type="submit" loading={loading}>
            {mode === "remove" ? "确认移除" : "确认添加"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}