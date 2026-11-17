import { Link } from "react-router";
import { ChevronRight, Copy, Eye, Paperclip, Pencil, Pin } from "lucide-react";
import type { AdminShare, Share } from "@/lib/types";
import { cn, formatTime, splitTags } from "@/lib/utils";
import { TASK_STATUS_LABEL } from "@/lib/status";
import { Badge, Card, TechTag } from "./ui";

type AnyShare = AdminShare | Share;

export function ShareCard({
  share,
  to,
  selectable = false,
  selected = false,
  onToggleSelect,
  onCopy,
  onPin,
  editTo,
}: {
  share: AnyShare;
  to: string;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onCopy?: () => void;
  onPin?: (next: boolean) => void;
  editTo?: string;
}) {
  const admin = "status" in share;
  const tags = splitTags(share.tech_tags);

  return (
    <Card className={cn("group relative flex flex-col gap-3 p-4 transition-colors hover:border-primary/40", selected && "border-primary/60 bg-primary-soft/20")}>
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => undefined}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect?.({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
          }}
          className="absolute top-4 left-4 size-4 accent-primary"
          aria-label={`选择《${share.title}》`}
        />
      )}

      <div className={cn("flex min-w-0 flex-col gap-2", selectable && "pl-7")}>
        <div className="flex items-start gap-2">
          <Link to={to} className="min-w-0 flex-1 text-base font-semibold text-pretty hover:text-primary">
            {share.title}
          </Link>
          {!!share.pinned && (
            <Badge tone="primary" className="shrink-0">
              <Pin className="size-3" /> 置顶
            </Badge>
          )}
          {admin && <Badge tone={share.status === "published" ? "success" : share.status === "draft" ? "warning" : "muted"}>{TASK_STATUS_LABEL[share.status]}</Badge>}
        </div>

        {"excerpt" in share && share.excerpt && <p className="line-clamp-2 text-sm text-muted-foreground">{share.excerpt}</p>}

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <TechTag key={tag}>{tag}</TechTag>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {share.creator_name && <span>{share.creator_name}</span>}
          <span>{formatTime(share.created_at)}</span>
          <span className="flex items-center gap-1">
            <Eye className="size-3.5" /> {share.view_count} 浏览
          </span>
          {!!share.file_count && (
            <span className="flex items-center gap-1">
              <Paperclip className="size-3.5" /> {share.file_count}
            </span>
          )}
          {admin && share.class_names && <span className="truncate">可见：{share.class_names}</span>}
          {admin && !share.class_names && share.audience_all === 1 && <span>可见：全部学员</span>}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1 border-t pt-2">
        {editTo && (
          <Link to={editTo} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Pencil className="size-3.5" /> 编辑
          </Link>
        )}
        {onPin && admin && (
          <button
            type="button"
            onClick={() => onPin(!share.pinned)}
            className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted", share.pinned ? "text-primary" : "text-muted-foreground hover:text-foreground")}
          >
            <Pin className="size-3.5" /> {share.pinned ? "取消置顶" : "置顶"}
          </button>
        )}
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Copy className="size-3.5" /> 复制链接
          </button>
        )}
      </div>
    </Card>
  );
}

/** 分享资料的列表行，与卡片视图共用勾选、置顶、复制与编辑操作 */
export function ShareRow({
  share,
  to,
  selectable = false,
  selected = false,
  onToggleSelect,
  onCopy,
  onPin,
  editTo,
}: {
  share: AnyShare;
  to: string;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onCopy?: () => void;
  onPin?: (next: boolean) => void;
  editTo?: string;
}) {
  const admin = "status" in share;
  const tags = splitTags(share.tech_tags);

  return (
    <div className={cn("group flex items-stretch hover:bg-muted/40", selected && "bg-primary-soft/30")}>
      {selectable && (
        <label className="flex cursor-pointer items-center pr-3 pl-5">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
            }}
            className="size-4 accent-primary"
            aria-label={`选择《${share.title}》`}
          />
        </label>
      )}

      <Link
        to={to}
        className={cn("flex flex-1 flex-col gap-2 py-3 pr-4 @lg:flex-row @lg:items-center @lg:gap-4", !selectable && "pl-5")}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium group-hover:text-primary">{share.title}</span>
            {!!share.pinned && <Pin className="size-3.5 shrink-0 text-primary" aria-label="置顶" />}
            {admin && <Badge tone={share.status === "published" ? "success" : share.status === "draft" ? "warning" : "muted"}>{TASK_STATUS_LABEL[share.status]}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {tags.slice(0, 4).map((tag) => (
              <TechTag key={tag}>{tag}</TechTag>
            ))}
            {tags.length > 4 && <span className="text-xs text-muted-foreground">+{tags.length - 4}</span>}
            {share.creator_name && <span className="text-xs text-muted-foreground">{share.creator_name}</span>}
          </div>
        </div>

        {admin && (
          <div className="hidden w-28 shrink-0 truncate text-sm text-muted-foreground @3xl:block">
            {share.class_names || (share.audience_all === 1 ? "全部学员" : "指定班级")}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground @lg:w-44">
          <span className="whitespace-nowrap">{formatTime(share.created_at)}</span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            <Eye className="size-3.5" aria-hidden="true" /> {share.view_count}
          </span>
          {!!share.file_count && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Paperclip className="size-3.5" aria-hidden="true" /> {share.file_count}
            </span>
          )}
          <ChevronRight className="hidden size-4 shrink-0 transition-transform group-hover:translate-x-0.5 @lg:block" aria-hidden="true" />
        </div>
      </Link>

      {(editTo || onPin || onCopy) && (
        <div className="hidden shrink-0 items-center gap-0.5 pr-2 @lg:flex">
          {editTo && (
            <Link
              to={editTo}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              title="编辑"
              aria-label={`编辑《${share.title}》`}
            >
              <Pencil className="size-3.5" />
            </Link>
          )}
          {onPin && admin && (
            <button
              type="button"
              onClick={() => onPin(!share.pinned)}
              className={cn(
                "flex size-7 items-center justify-center rounded-md hover:bg-muted",
                share.pinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              title={share.pinned ? "取消置顶" : "置顶"}
              aria-label={share.pinned ? `取消置顶《${share.title}》` : `置顶《${share.title}》`}
            >
              <Pin className="size-3.5" />
            </button>
          )}
          {onCopy && (
            <button
              type="button"
              onClick={onCopy}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              title="复制链接"
              aria-label={`复制《${share.title}》的分享链接`}
            >
              <Copy className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ShareListHeader({
  selectable,
  allSelected,
  onToggleAll,
  admin,
}: {
  selectable?: boolean;
  allSelected?: boolean;
  onToggleAll?: () => void;
  admin?: boolean;
}) {
  return (
    <div className="hidden items-center gap-4 border-b bg-muted/50 px-5 py-2.5 text-xs font-medium text-muted-foreground @lg:flex">
      {selectable && (
        <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={!!allSelected} onChange={onToggleAll} aria-label="选择全部筛选结果" />
      )}
      <span className="flex-1">资料</span>
      {admin && <span className="hidden w-28 shrink-0 @3xl:block">发布范围</span>}
      <span className="w-44 shrink-0">发布时间 / 浏览</span>
      {admin && <span className="w-24 shrink-0" aria-hidden="true" />}
    </div>
  );
}
