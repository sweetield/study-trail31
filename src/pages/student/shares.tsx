import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { BookOpen, Download, SearchX, X } from "lucide-react";
import type { Share } from "@/lib/types";
import { useFilteredShares, useShareFilters } from "@/hooks/use-share-list";
import { useViewMode } from "@/hooks/use-task-list";
import { ShareCard, ShareListHeader, ShareRow } from "@/components/share-item";
import { ShareToolbar } from "@/components/share-toolbar";
import { ShareExportDialog } from "@/components/share-export-dialog";
import { ViewToggle } from "@/components/task-toolbar";
import { useToast } from "@/components/toast";
import { Button, Card, EmptyState, PageHeader, PageLoader } from "@/components/ui";

const NO_SHARES: Share[] = [];
const searchFields = (s: Share) => [s.title, s.tech_tags, s.creator_name];

export default function StudentShares() {
  const toast = useToast();
  const { data } = useSWR<{ shares: Share[] }>("/api/shares");
  const [filters, setFilters] = useShareFilters();
  const [view, setView] = useViewMode("student-shares", "grid");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreset, setExportPreset] = useState<number[] | undefined>(undefined);
  const anchorRef = useRef<number | null>(null);
  const all = data?.shares ?? NO_SHARES;
  const { items, total, tags } = useFilteredShares(all, filters, searchFields);

  const filterKey = [filters.q, filters.tag, filters.sort].join("|");
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

  function openExport(preset?: number[]) {
    // 没有显式传入 id 时，若列表里已勾选资料，则只导出勾选项
    setExportPreset(preset ?? (selected.size ? [...selected] : undefined));
    setExportOpen(true);
  }

  async function copyLink(id: number) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${id}`);
      toast("分享链接已复制");
    } catch {
      toast("复制失败，请手动复制地址栏链接", "error");
    }
  }

  if (!data) return <PageLoader />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="分享资料"
        description="辅导员发布的学习资料，置顶内容会优先显示"
        action={
          <Button variant="outline" onClick={() => openExport()} disabled={!all.length}>
            <Download /> 导出资料
          </Button>
        }
      />

      {all.length === 0 ? (
        <Card>
          <EmptyState icon={<BookOpen />} title="暂无分享资料" description="辅导员发布资料后会显示在这里" />
        </Card>
      ) : (
        <>
          <ShareToolbar filters={filters} onChange={setFilters} tags={tags} placeholder="搜索资料标题、标签或发布人" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground" aria-live="polite">
              共 {total} 篇资料
            </span>
            <div className="flex items-center gap-3">
              {total > 0 && (
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground" title="选择全部筛选结果">
                  <input type="checkbox" className="size-4 accent-primary" checked={allChecked} onChange={toggleAll} aria-label="选择全部筛选结果" />
                  全选
                </label>
              )}
              <ViewToggle value={view} onChange={setView} />
            </div>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-primary-soft/40 px-4 py-3">
              <span className="mr-1 text-sm font-medium">已选 {selected.size} 篇资料</span>
              <Button size="sm" variant="outline" onClick={() => openExport([...selected])}>
                <Download /> 导出
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="ml-auto">
                <X /> 取消选择
              </Button>
            </div>
          )}

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
                  to={`/app/shares/${share.id}`}
                  selectable
                  selected={selected.has(share.id)}
                  onToggleSelect={(event) => toggleSelect(share.id, event)}
                  onCopy={() => copyLink(share.id)}
                />
              ))}
            </div>
          ) : (
            <Card className="@container overflow-hidden">
              <ShareListHeader selectable allSelected={allChecked} onToggleAll={toggleAll} />
              <ul className="divide-y">
                {items.map((share) => (
                  <li key={share.id}>
                    <ShareRow
                      share={share}
                      to={`/app/shares/${share.id}`}
                      selectable
                      selected={selected.has(share.id)}
                      onToggleSelect={(event) => toggleSelect(share.id, event)}
                      onCopy={() => copyLink(share.id)}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <ShareExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        shares={all}
        endpoint="/api/shares/export"
        presetIds={exportPreset}
      />
    </div>
  );
}
