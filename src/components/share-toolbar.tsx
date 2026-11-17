import { Search, X } from "lucide-react";
import type { ShareFilters, ShareSort } from "@/hooks/use-share-list";
import { Button, Card, Input, Select } from "./ui";
import { TagMultiSelect } from "./task-toolbar";

const SORT_OPTIONS: { key: ShareSort; label: string }[] = [
  { key: "new", label: "最新发布" },
  { key: "views", label: "最多浏览" },
];

export function ShareToolbar({
  filters,
  onChange,
  tags,
  placeholder,
}: {
  filters: ShareFilters;
  onChange: (patch: Partial<ShareFilters>) => void;
  tags: { tag: string; count: number }[];
  placeholder: string;
}) {
  const active = !!(filters.q || filters.tag);
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
            aria-label="搜索资料"
          />
        </div>
        <Select value={filters.sort} onChange={(e) => onChange({ sort: e.target.value as ShareSort })} aria-label="排序方式" className="lg:w-36">
          {SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {(tags.length > 0 || active) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">资料标签</span>
          <TagMultiSelect techs={tags} value={filters.tag} onChange={(tag) => onChange({ tag })} />
          {active && (
            <Button variant="ghost" size="sm" onClick={() => onChange({ q: "", tag: "" })} className="ml-auto shrink-0 text-muted-foreground">
              <X /> 清除筛选
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
