import { Link, useParams } from "react-router";
import useSWR from "swr";
import { ArrowLeft, Share2 } from "lucide-react";
import type { ShareDetail } from "@/lib/types";
import { useMe } from "@/lib/auth";
import { Logo } from "@/components/app-shell";
import { NotificationBell } from "@/components/notification-bell";
import { ShareDetailView } from "@/components/share-detail";
import { useToast } from "@/components/toast";
import { buttonVariants, EmptyState, PageLoader } from "@/components/ui";

/**
 * 分享链接阅读页：不进入管理端 / 学员端导航，但仍然要求登录，
 * 可见范围由 /api/shares/:id 按班级与排除名单校验。
 */
export default function SharePage() {
  const { id } = useParams();
  const { data, error } = useSWR<ShareDetail>(`/api/shares/${id}`);
  const { user } = useMe();
  const toast = useToast();
  const backTo = user?.role === "admin" ? "/admin/shares" : "/app/shares";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast("链接已复制");
    } catch {
      toast("复制失败，请手动复制地址栏链接", "error");
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-muted/20">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4">
          <Link to={backTo} aria-label="返回学迹">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            <NotificationBell align="right" />
            <Link to={backTo} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ArrowLeft /> 返回
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {error ? (
          <EmptyState
            title="资料不存在或未向你开放"
            description="分享链接需要登录后访问；如果确认辅导员已经发布，请联系辅导员检查班级与排除名单。"
            action={
              <Link to={backTo} className="text-sm text-primary hover:underline">
                返回资料列表
              </Link>
            }
          />
        ) : !data ? (
          <PageLoader />
        ) : (
          <ShareDetailView
            data={data}
            backTo={backTo}
            backLabel="返回资料列表"
            action={
              <button type="button" onClick={copyLink} className={buttonVariants({ variant: "outline" })}>
                <Share2 /> 复制链接
              </button>
            }
          />
        )}
      </main>
    </div>
  );
}
