import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, Clock, Eye, Paperclip, Pin, Users } from "lucide-react";
import type { ShareDetail } from "@/lib/types";
import { formatTime, splitTags } from "@/lib/utils";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { TASK_STATUS_LABEL } from "@/lib/status";
import { Badge, Card, CardHeader, EmptyState, TechTag } from "./ui";
import { FileChips, filesNotReferenced } from "./attachments";
import { Avatar } from "./avatar";
import { Markdown } from "./markdown";
import { ReadingModeButton } from "./app-shell";

/** 辅导员与学员共用的资料阅读视图，保证分享链接中的排版与站内一致 */
export function ShareDetailView({
  data,
  backTo,
  backLabel,
  action,
}: {
  data: ShareDetail;
  backTo: string;
  backLabel: string;
  action?: ReactNode;
}) {
  const { share, files } = data;
  useDocumentTitle(share.title);
  const extraFiles = filesNotReferenced(files, share.description);
  const tags = splitTags(share.tech_tags);

  return (
    <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 xl:max-w-[64rem] 2xl:max-w-[70rem]">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Link to={backTo} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> {backLabel}
          </Link>
          <ReadingModeButton />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {!!share.pinned && (
                <Badge tone="primary">
                  <Pin className="size-3" /> 置顶
                </Badge>
              )}
              {share.status !== "published" && <Badge tone={share.status === "draft" ? "warning" : "muted"}>{TASK_STATUS_LABEL[share.status]}</Badge>}
              <Badge tone="outline">
                <Users className="size-3" /> {share.class_names || "全部学员"}
              </Badge>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{share.title}</h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {share.creator_name && (
                <span className="flex items-center gap-1.5">
                  <Avatar name={share.creator_name} avatarId={share.creator_avatar_id} className="size-5 text-[10px]" />
                  辅导员 {share.creator_name}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" /> {formatTime(share.created_at)}
              </span>
              <span className="flex items-center gap-1">
                <Eye className="size-3.5" /> {share.view_count} 次浏览
              </span>
              {files.length > 0 && (
                <span className="flex items-center gap-1">
                  <Paperclip className="size-3.5" /> {files.length} 个附件
                </span>
              )}
            </p>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <TechTag key={tag}>{tag}</TechTag>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {action}
          </div>
        </div>
      </div>

      {/* 正文独占一列，元信息折叠到底部，长文阅读不再被侧栏挤压 */}
      <Card>
        <CardHeader title="资料内容" />
        {share.description.trim() || extraFiles.length > 0 ? (
          <>
            {share.description.trim() && <Markdown source={share.description} className="reading-body px-5 py-5 lg:px-8" toc />}
            {extraFiles.length > 0 && <FileChips files={extraFiles} className="px-5 pb-5 lg:px-8" />}
          </>
        ) : (
          <EmptyState title="这份资料暂时没有正文" description="请查看下方附件，或联系辅导员补充内容" />
        )}
      </Card>

      <details className="rounded-xl border bg-card px-5 py-4 text-sm">
        <summary className="cursor-pointer font-medium">资料信息</summary>
        <dl className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          <InfoRow label="发布人">{share.creator_name ?? "辅导员"}</InfoRow>
          <InfoRow label="发布时间">{formatTime(share.created_at)}</InfoRow>
          <InfoRow label="最近更新">{formatTime(share.updated_at)}</InfoRow>
          <InfoRow label="可见范围">{share.class_names || "全部学员"}</InfoRow>
          <InfoRow label="访问量">{share.view_count} 次</InfoRow>
          <InfoRow label="附件数">{files.length} 个</InfoRow>
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">访问量按登录学员首次打开统计，同一学员重复查看不重复累加。</p>
      </details>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-1.5 last:border-b-0 sm:border-b-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
