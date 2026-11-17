import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import useSWR from "swr";
import { Archive, BookOpen, Download, Plus, SearchX, Share2, Tag, Tags, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { AdminShare, ShareStatus } from "@/lib/types";
import { TASK_STATUS_LABEL } from "@/lib/status";
import { useQueryParam, useViewMode } from "@/hooks/use-task-list";
import { useFilteredShares, useShareFilters } from "@/hooks/use-share-list";
import { ShareCard, ShareListHeader, ShareRow } from "@/components/share-item";
import { ShareToolbar } from "@/components/share-toolbar";
import { ShareExportDialog } from "@/components/share-export-dialog";
import { ViewToggle } from "@/components/task-toolbar";
import { useToast } from "@/components/toast";
import { Button, buttonVariants, Card, Dialog, EmptyState, Field, Input, PageHeader, PageLoader, SegmentedTabs } from "@/components/ui";

const TABS = (["published", "draft", "archived"] as const).map((key) => ({ key, label: TASK_STATUS_LABEL[key] }));

const NO_SHARES: AdminShare[] = [];
const searchFields = (s: AdminShare) => [s.title, s.tech_tags, s.class_names, s.creator_name];

export default function AdminShares() {
  const toast = useToast();
  const { data, mutate: reload } = useSWR<{ shares: AdminShare[] }>("/api/admin/shares");
  const [tab, setTab] = useQueryParam<ShareStatus>("status", TABS, "published");
  const [filters, setFilters] = useShareFilters();
  const [view, setView] = useViewMode("admin-shares", "grid");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagMode, setTagMode] = useState<"add" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreset, setExportPreset] = useState<number[] | undefined>(undefined);
  const anchorRef = useRef<number | null>(null);

  const all = data?.shares ?? NO_SHARES;
  const inTab = useMemo(() => all.filter((s) => s.status === tab), [all, tab]);
  const { items, total, tags } = useFilteredShares(inTab, filters, searchFields);

  const filterKey = [tab, filters.q, filters.tag, filters.sort].join("|");
  useEffect(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, [filterKey]);

  const allChecked = items.length > 0 && items.every((s) => selected.has(s.id));

  function toggleSelect(id: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    const index = items.findIndex((s) => s.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && anchorRef.current != null) {
        const anchorIndex = items.findIndex((s) => s.id === anchorRef.current);
        if (anchorIndex >= 0 && index >= 0) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          for (let i = start; i <= end; i++) next.add(items[i].id);
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
    setSelected(allChecked ? new Set() : new Set(items.map((s) => s.id)));
    anchorRef.current = null;
  }

  async function batchUpdate(payload: { status?: ShareStatus; add_tags?: string; remove_tags?: string }, message: string) {
    setBusy(true);
    try {
      await api.post("/api/admin/shares/batch-update", { ids: [...selected], ...payload });
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

  async function batchDelete() {
    if (!confirm(`确定删除选中的 ${selected.size} 篇资料吗？资料正文、附件与访问记录都会被永久删除。若只是暂时不用，建议改用归档。`)) return;
    setBusy(true);
    try {
      await api.post("/api/admin/shares/batch-delete", { ids: [...selected] });
      await reload();
      setSelected(new Set());
      toast("已删除所选资料");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(share: AdminShare) {
    try {
      await api.post(`/api/admin/shares/${share.id}/pin`, { pinned: !share.pinned });
      await reload();
      toast(share.pinned ? "已取消置顶" : "已置顶，置顶资料会排在学员列表最前");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function copyLink(id: number) {
    const url = `${window.location.origin}/s/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("分享链接已复制，学员登录后即可查看");
    } catch {
      toast("复制失败，请手动复制地址栏链接", "error");
    }
  }

  function openExport(preset?: number[]) {
    // 页头按钮没有显式传入 id 时，若列表里已勾选资料，则只导出勾选项
    setExportPreset(preset ?? (selected.size ? [...selected] : undefined));
    setExportOpen(true);
  }

  if (!data) return <PageLoader />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="分享资料"
        description="发布学习资料，学员按班级查看；资料与学习任务、进度统计相互独立"
        action={
          <>
            <Button variant="outline" onClick={() => openExport()} disabled={!all.length}>
              <Download /> 导出资料
            </Button>
            <Link to="/admin/shares/new" className={buttonVariants()}>
              <Plus /> 发布资料
            </Link>
          </>
        }
      />

      <div className="flex items-center justify-between gap-3">
        <SegmentedTabs
          label="资料状态"
          options={TABS.map((t) => ({ ...t, count: all.filter((s) => s.status === t.key).length }))}
          value={tab}
          onChange={setTab}
        />
        <div className="flex items-center gap-3">
          {total > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground" title="选择全部筛选结果">
              <input type="checkbox" className="size-4 accent-primary" checked={allChecked} onChange={toggleAll} aria-label="选择全部筛选结果" />
              全选
            </label>
          )}
          <span className="hidden text-sm text-muted-foreground sm:inline" aria-live="polite">
            共 {total} 篇资料
          </span>
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-primary-soft/40 px-4 py-3">
          <span className="mr-1 text-sm font-medium">已选 {selected.size} 篇资料</span>
          <Button size="sm" variant="outline" onClick={() => batchUpdate({ status: "archived" }, "已归档所选资料")} disabled={busy || tab === "archived"}>
            <Archive /> 归档
          </Button>
          <Button size="sm" variant="outline" onClick={() => openExport([...selected])} disabled={busy}>
            <Download /> 导出
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
            icon={<BookOpen />}
            title={`暂无${TASK_STATUS_LABEL[tab]}资料`}
            description="发布资料后，学员可在「分享资料」中查看"
            action={
              tab !== "archived" ? (
                <Link to="/admin/shares/new" className="text-sm text-primary hover:underline">
                  立即发布
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <ShareToolbar filters={filters} onChange={setFilters} tags={tags} placeholder="搜索资料标题、标签、班级或发布人" />
          {total === 0 ? (
            <Card>
              <EmptyState icon={<SearchX />} title="没有符合条件的资料" description="试试调整关键词或资料标签" />
            </Card>
          ) : view === "grid" ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {items.map((share) => (
                <ShareCard
                  key={share.id}
                  share={share}
                  to={`/admin/shares/${share.id}`}
                  editTo={`/admin/shares/${share.id}/edit`}
                  selectable
                  selected={selected.has(share.id)}
                  onToggleSelect={(event) => toggleSelect(share.id, event)}
                  onPin={() => togglePin(share)}
                  onCopy={() => copyLink(share.id)}
                />
              ))}
            </div>
          ) : (
            <Card className="@container overflow-hidden">
              <ShareListHeader selectable admin allSelected={allChecked} onToggleAll={toggleAll} />
              <ul className="divide-y">
                {items.map((share) => (
                  <li key={share.id}>
                    <ShareRow
                      share={share}
                      to={`/admin/shares/${share.id}`}
                      editTo={`/admin/shares/${share.id}/edit`}
                      selectable
                      selected={selected.has(share.id)}
                      onToggleSelect={(event) => toggleSelect(share.id, event)}
                      onPin={() => togglePin(share)}
                      onCopy={() => copyLink(share.id)}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <div className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-3 text-xs text-muted-foreground">
        <Share2 className="size-4 shrink-0" />
        分享链接格式为 /s/资料ID，学员需登录后访问，并仍受班级与排除名单限制。
      </div>

      <ShareTagDialog
        key={tagMode ?? "closed"}
        mode={tagMode}
        count={selected.size}
        loading={busy}
        onClose={() => setTagMode(null)}
        onApply={(value) =>
          batchUpdate(
            tagMode === "remove" ? { remove_tags: value } : { add_tags: value },
            tagMode === "remove" ? "已移除所选资料的标签" : "已为所选资料添加标签",
          )
        }
      />

      <ShareExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        shares={all}
        endpoint="/api/admin/shares/export"
        presetIds={exportPreset}
      />
    </div>
  );
}

function ShareTagDialog({
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
      description={`将${mode === "remove" ? "移除" : "添加"}的标签应用到选中的 ${count} 篇资料`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (tags.trim()) onApply(tags);
        }}
        className="flex flex-col gap-4"
      >
        <Field label="资料标签" htmlFor="batch-share-tags" hint="多个标签用空格、逗号或中文逗号分隔；单个标签不超过 24 个字符">
          <Input
            id="batch-share-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            required
            autoFocus
            placeholder={mode === "remove" ? "例如：React Vue" : "例如：面试题 前端"}
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
