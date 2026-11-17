import { useEffect, useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { ShareStatus } from "@/lib/types";
import { TASK_STATUS_LABEL } from "@/lib/status";
import { useToast } from "./toast";
import { Button, Dialog, Input } from "./ui";

export interface ShareExportOption {
  id: number;
  title: string;
  status?: ShareStatus;
}

/**
 * 分享资料导出弹窗：支持一次勾选多篇资料。
 * 导出为 ZIP，内含 Markdown 正文与本地附件；辅导员和学员共用，只是接口不同。
 */
export function ShareExportDialog({
  open,
  onClose,
  shares,
  endpoint,
  fallbackName = "分享资料.zip",
  presetIds,
}: {
  open: boolean;
  onClose: () => void;
  shares: ShareExportOption[];
  endpoint: string;
  fallbackName?: string;
  /** 从批量操作栏打开时，优先导出已勾选的资料 */
  presetIds?: number[];
}) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const available = new Set(shares.map((share) => share.id));
    const preset = (presetIds ?? []).filter((id) => available.has(id));
    setSelected(new Set(preset.length ? preset : shares.map((share) => share.id)));
    setQuery("");
    // 仅在打开弹窗时重置选择，避免后台刷新时清空用户的勾选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? shares.filter((share) => share.title.toLowerCase().includes(q)) : shares;
  }, [shares, query]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const allVisible = filtered.length > 0 && filtered.every((share) => selected.has(share.id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const share of filtered) {
        if (allVisible) next.delete(share.id);
        else next.add(share.id);
      }
      return next;
    });
  }

  async function run() {
    if (!selected.size) {
      toast("请至少选择一篇资料", "error");
      return;
    }
    const params = new URLSearchParams({ share_ids: [...selected].join(",") });
    setLoading(true);
    try {
      await api.download(`${endpoint}?${params.toString()}`, fallbackName);
      toast("导出完成，压缩包已开始下载");
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  const allVisible = filtered.length > 0 && filtered.every((share) => selected.has(share.id));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导出分享资料"
      description="选择一个或多个资料，导出为包含正文与附件文件的 ZIP 压缩包"
    >
      <div className="flex flex-col gap-4">
        {shares.length > 6 && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索资料标题" className="pl-9" aria-label="搜索资料" />
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            已选 {selected.size} / {shares.length} 篇资料
          </span>
          <button type="button" onClick={toggleAll} className="text-primary hover:underline">
            {allVisible ? "取消全选" : "全选当前列表"}
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto rounded-lg border">
          {filtered.length ? (
            <ul className="divide-y">
              {filtered.map((share) => (
                <li key={share.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50">
                    <input type="checkbox" checked={selected.has(share.id)} onChange={() => toggle(share.id)} className="size-4 accent-primary" />
                    <span className="min-w-0 flex-1 truncate">{share.title}</span>
                    {share.status && <span className="shrink-0 text-xs text-muted-foreground">{TASK_STATUS_LABEL[share.status]}</span>}
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的资料</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          导出内容包含资料标题、正文、发布时间、标签与附件；图片和附件会一并打包到压缩包的「附件」目录中，Markdown 内使用本地相对路径。
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
