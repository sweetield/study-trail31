import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LayoutGrid, List, Search, X } from "lucide-react";
import type { TaskFilters } from "@/hooks/use-task-list";
import { DUE_BUCKETS, GROUP_OPTIONS, SORT_OPTIONS, type DueBucket, type GroupBy, type SortBy, type ViewMode } from "@/lib/task-view";
import { cn, splitTags } from "@/lib/utils";
import { Button, Card, Input, Select } from "./ui";

export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  const modes = [
    { key: "grid" as const, label: "卡片视图", icon: LayoutGrid },
    { key: "list" as const, label: "列表视图", icon: List },
  ];
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border bg-card p-0.5" role="group" aria-label="显示方式">
      {modes.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          title={label}
          onClick={() => onChange(key)}
          className={cn("flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground", value === key && "bg-muted text-foreground")}
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

interface ToolbarProps {
  filters: TaskFilters;
  onChange: (patch: Partial<TaskFilters>) => void;
  techs: { tag: string; count: number }[];
  dueCounts: Record<DueBucket, number>;
  placeholder: string;
}

export function TaskToolbar({ filters, onChange, techs, dueCounts, placeholder }: ToolbarProps) {
  const active = !!(filters.q || filters.tech || filters.due);

  return (
    <Card className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-2 lg:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={filters.q}
            onChange={(e) => onChange({ q: e.target.value })}
            placeholder={placeholder}
            className="pl-9"
            aria-label="搜索任务"
          />
        </div>
        <div className="grid grid-cols-3 gap-2 lg:flex">
          <Select value={filters.due} onChange={(e) => onChange({ due: e.target.value as DueBucket | "" })} aria-label="按截止日期筛选" className="lg:w-36">
            <option value="">全部日期</option>
            {DUE_BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}（{dueCounts[b.key]}）
              </option>
            ))}
          </Select>
          <Select value={filters.group} onChange={(e) => onChange({ group: e.target.value as GroupBy })} aria-label="分组方式" className="lg:w-32">
            {GROUP_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.sort} onChange={(e) => onChange({ sort: e.target.value as SortBy })} aria-label="排序方式" className="lg:w-32">
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {(techs.length > 0 || active) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">学习技术</span>
          <TagMultiSelect techs={techs} value={filters.tech} onChange={(tech) => onChange({ tech })} />
          {active && (
            <Button variant="ghost" size="sm" onClick={() => onChange({ q: "", tech: "", due: "" })} className="ml-auto shrink-0 text-muted-foreground">
              <X /> 清除筛选
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function TagMultiSelect({
  techs,
  value,
  onChange,
}: {
  techs: { tag: string; count: number }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = splitTags(value);
  const counts = new Map(techs.map((t) => [t.tag, t.count]));

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

  function toggle(tag: string) {
    const next = selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag];
    onChange(next.join(","));
  }

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm transition-colors hover:bg-muted",
          selected.length && "border-primary text-primary",
        )}
      >
        {selected.length ? `已选 ${selected.length} 个标签` : "选择技术标签"}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>

      {selected.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => toggle(tag)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-primary bg-primary-soft px-2 py-1 font-mono text-xs text-primary"
          aria-label={`取消筛选 ${tag}`}
        >
          {tag}
          {counts.get(tag) !== undefined && <span className="tabular-nums opacity-70">{counts.get(tag)}</span>}
          <X className="size-3" />
        </button>
      ))}

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="技术标签多选"
          className="absolute top-full left-0 z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border bg-card p-1.5 shadow-xl"
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs text-muted-foreground">可多选，匹配任一标签</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange("")} className="text-xs text-primary hover:underline">
                清除
              </button>
            )}
          </div>
          {techs.length ? (
            techs.map(({ tag, count }) => {
              const checked = selected.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => toggle(tag)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                    checked && "bg-primary-soft/60 text-primary",
                  )}
                >
                  <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", checked ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
                    {checked && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{tag}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
                </button>
              );
            })
          ) : (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无技术标签</p>
          )}
        </div>
      )}
    </div>
  );
}
