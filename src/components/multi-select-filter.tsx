import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Input } from "@/components/ui";

/**
 * 通用多选筛选：下拉面板 + 搜索 + 全选/清除。
 * 空选表示不筛选，与后端 *_ids 参数语义一致。
 */
export function MultiSelectFilter({
  icon,
  label,
  options,
  value,
  onChange,
  searchPlaceholder,
  emptyText,
  align = "right",
}: {
  icon: ReactNode;
  label: string;
  options: { id: number; title: string }[];
  value: number[];
  onChange: (next: number[]) => void;
  searchPlaceholder: string;
  emptyText: string;
  /** 下拉面板与按钮的对齐方向 */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const selected = new Set(value);
  const keyword = query.trim().toLowerCase();
  const shown = keyword ? options.filter((o) => o.title.toLowerCase().includes(keyword)) : options;
  const shownIds = new Set(shown.map((o) => o.id));
  const allShownSelected = shown.length > 0 && shown.every((o) => selected.has(o.id));

  function toggle(id: number) {
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  function toggleAllShown() {
    if (allShownSelected) {
      onChange(value.filter((id) => !shownIds.has(id)));
    } else {
      onChange([...new Set([...value, ...shownIds])]);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(value.length > 0 && "border-primary text-primary")}
      >
        {icon} {label}
        {value.length > 0 ? `（${value.length}）` : ""}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={cn(
            "absolute top-full z-30 mt-1 flex w-72 flex-col gap-2 rounded-xl border bg-card p-2 shadow-xl",
            align === "left" ? "left-0" : "right-0",
          )}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-9"
              aria-label={searchPlaceholder}
              autoFocus
            />
          </div>

          <div className="flex items-center justify-between px-1 text-xs">
            <span className="text-muted-foreground tabular-nums">
              已选 {value.length} / {options.length}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={toggleAllShown} disabled={!shown.length} className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">
                {allShownSelected ? "取消全选" : "全选"}
              </button>
              {value.length > 0 && (
                <button type="button" onClick={() => onChange([])} className="text-primary hover:underline">
                  清除
                </button>
              )}
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-lg border">
            {shown.length ? (
              <ul className="divide-y">
                {shown.map((option) => {
                  const checked = selected.has(option.id);
                  return (
                    <li key={option.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50">
                        <input type="checkbox" checked={checked} onChange={() => toggle(option.id)} className="size-4 accent-primary" />
                        <span className="min-w-0 flex-1 truncate" title={option.title}>
                          {option.title}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {options.length ? "没有匹配的选项" : emptyText}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between border-t pt-2 pl-1">
            <span className="text-xs text-muted-foreground">不勾选即显示全部</span>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              完成
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
