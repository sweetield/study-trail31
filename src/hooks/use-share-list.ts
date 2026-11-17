import { useCallback, useDeferredValue, useMemo } from "react";
import { useSearchParams } from "react-router";
import { splitTags } from "@/lib/utils";

export type ShareSort = "new" | "views";

export interface ShareFilters {
  q: string;
  tag: string;
  sort: ShareSort;
}

const DEFAULTS: ShareFilters = { q: "", tag: "", sort: "new" };

export function useShareFilters() {
  const [params, setParams] = useSearchParams();
  const filters: ShareFilters = {
    q: params.get("q") ?? "",
    tag: params.get("tag") ?? "",
    sort: params.get("sort") === "views" ? "views" : "new",
  };
  const update = useCallback(
    (patch: Partial<ShareFilters>) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (!v || v === DEFAULTS[k as keyof ShareFilters]) p.delete(k);
            else p.set(k, v);
          }
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [filters, update] as const;
}

interface ShareLike {
  id: number;
  title: string;
  tech_tags: string;
  pinned: number;
  view_count: number;
  created_at: number;
  creator_name?: string | null;
}

export function useFilteredShares<T extends ShareLike>(shares: T[], filters: ShareFilters, searchFields: (share: T) => (string | null | undefined)[]) {
  const q = useDeferredValue(filters.q.trim().toLowerCase());
  return useMemo(() => {
    const searched = q ? shares.filter((share) => searchFields(share).some((field) => field?.toLowerCase().includes(q))) : shares;
    const selectedTags = splitTags(filters.tag);
    const byTag = selectedTags.length
      ? searched.filter((share) => {
          const tags = splitTags(share.tech_tags);
          return selectedTags.some((tag) => tags.includes(tag));
        })
      : searched;
    const tagCounts = new Map<string, number>();
    for (const share of byTag) {
      for (const tag of splitTags(share.tech_tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const items = [...byTag].sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      if (filters.sort === "views" && a.view_count !== b.view_count) return b.view_count - a.view_count;
      return b.created_at - a.created_at || b.id - a.id;
    });
    return {
      items,
      total: items.length,
      tags: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    };
    // searchFields 为每个页面稳定的取值函数，不参与依赖避免重复计算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shares, q, filters.tag, filters.sort]);
}
