import { useEffect, useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "./toast";
import { Button, Dialog, Input } from "./ui";

export interface ExportTaskOption {
  id: number;
  title: string;
}

/**
 * 学习进度导出弹窗：支持一次勾选多个任务。
 * 导出为 ZIP，内含 Markdown 与本地附件；学员端导出自己的学习进度，管理员端可额外按班级 / 学员限定范围。
 */
export function ExportDialog({
  open,
  onClose,
  tasks,
  mode,
  classId,
  classIds,
  userId,
  presetIds,
}: {
  open: boolean;
  onClose: () => void;
  tasks: ExportTaskOption[];
  mode: "student" | "admin";
  classId?: number | null;
  /** 多班级筛选：与 classId 同时出现时优先生效 */
  classIds?: number[];
  userId?: number | null;
  /** 从列表批量操作打开时，优先导出已勾选的任务 */
  presetIds?: number[];
}) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const available = new Set(tasks.map((task) => task.id));
    const preset = (presetIds ?? []).filter((id) => available.has(id));
    setSelected(new Set(preset.length ? preset : tasks.map((task) => task.id)));
    setQuery("");
    // 仅在打开弹窗时重置选择，避免 SWR 后台刷新时清空用户的勾选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tasks.filter((task) => task.title.toLowerCase().includes(q)) : tasks;
  }, [tasks, query]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const allVisible = filtered.length > 0 && filtered.every((task) => selected.has(task.id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const task of filtered) {
        if (allVisible) next.delete(task.id);
        else next.add(task.id);
      }
      return next;
    });
  }

  async function run() {
    if (!selected.size) {
      toast("请至少选择一个任务", "error");
      return;
    }
    const params = new URLSearchParams({ task_ids: [...selected].join(",") });
    if (mode === "admin") {
      if (classIds?.length) params.set("class_ids", classIds.join(","));
      else if (classId) params.set("class_id", String(classId));
      if (userId) params.set("user_id", String(userId));
    }
    setLoading(true);
    try {
      await api.download(`/api/${mode === "student" ? "me" : "admin"}/export?${params.toString()}`, "学迹学习任务.zip");
      toast("导出完成，压缩包已开始下载");
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  const allVisible = filtered.length > 0 && filtered.every((task) => selected.has(task.id));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导出学习进度"
      description={mode === "student" ? "选择一个或多个任务，导出为包含附件文件的 ZIP 压缩包" : "选择任务导出完整进度，包含学员日志、附件与审核记录"}
    >
      <div className="flex flex-col gap-4">
        {tasks.length > 6 && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务名称" className="pl-9" aria-label="搜索任务" />
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            已选 {selected.size} / {tasks.length} 个任务
          </span>
          <button type="button" onClick={toggleAll} className="text-primary hover:underline">
            {allVisible ? "取消全选" : "全选当前列表"}
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto rounded-lg border">
          {filtered.length ? (
            <ul className="divide-y">
              {filtered.map((task) => (
                <li key={task.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={selected.has(task.id)} onChange={() => toggle(task.id)} className="size-4 accent-primary" />
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的任务</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          导出内容包含任务说明、学习步骤、笔记、作品链接、辅导员评语与学习日志；图片和附件会一并打包到压缩包的「附件」目录中，Markdown 内使用本地相对路径。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={run} loading={loading} disabled={!selected.size}>
            <Download /> 导出 ZIP
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
