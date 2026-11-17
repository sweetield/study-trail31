import { Link, useParams } from "react-router";
import useSWR from "swr";
import { Share2 } from "lucide-react";
import type { ShareDetail } from "@/lib/types";
import { ShareDetailView } from "@/components/share-detail";
import { useToast } from "@/components/toast";
import { Button, EmptyState, PageLoader } from "@/components/ui";

export default function StudentShareDetail() {
  const { id } = useParams();
  const { data, error } = useSWR<ShareDetail>(`/api/shares/${id}`);
  const toast = useToast();

  if (error) {
    return (
      <EmptyState
        title="资料不存在或未向你开放"
        description="如果确认辅导员已经发布，请联系辅导员检查班级与排除名单。"
        action={
          <Link to="/app/shares" className="text-sm text-primary hover:underline">
            返回分享资料
          </Link>
        }
      />
    );
  }
  if (!data) return <PageLoader />;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${data!.share.id}`);
      toast("分享链接已复制");
    } catch {
      toast("复制失败，请手动复制地址栏链接", "error");
    }
  }

  return (
    <ShareDetailView
      data={data}
      backTo="/app/shares"
      backLabel="分享资料"
      action={
        <Button variant="outline" onClick={copyLink}>
          <Share2 /> 复制链接
        </Button>
      }
    />
  );
}
