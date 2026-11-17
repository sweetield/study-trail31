import { Link, useNavigate, useParams } from "react-router";
import useSWR, { mutate } from "swr";
import { Archive, Pencil, Pin, PinOff, RotateCcw, Share2, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { AdminShare, FileMeta, ShareStatus } from "@/lib/types";
import { ShareDetailView } from "@/components/share-detail";
import { useToast } from "@/components/toast";
import { Button, buttonVariants, PageLoader } from "@/components/ui";

interface AdminShareDetailData {
  share: AdminShare & { description: string };
  files: FileMeta[];
  class_ids: number[];
  excluded_user_ids: number[];
}

export default function AdminShareDetail() {
  const { id } = useParams();
  const key = `/api/admin/shares/${id}`;
  const { data, mutate: refresh } = useSWR<AdminShareDetailData>(key);
  const navigate = useNavigate();
  const toast = useToast();

  if (!data) return <PageLoader />;
  const { share } = data;

  async function setStatus(status: ShareStatus) {
    await api.put(key, {
      title: share.title,
      description: share.description,
      tech_tags: share.tech_tags,
      class_ids: data!.class_ids,
      excluded_user_ids: data!.excluded_user_ids,
      audience_mode: share.audience_mode,
      status,
      file_ids: [],
    });
    await mutate((k) => typeof k === "string" && k.startsWith("/api/admin/"));
    toast(status === "archived" ? "资料已归档，学员端不再显示" : "资料已重新发布");
  }

  async function togglePin() {
    try {
      await api.post(`${key}/pin`, { pinned: !share.pinned });
      await mutate((k) => typeof k === "string" && k.startsWith("/api/admin/"));
      toast(share.pinned ? "已取消置顶" : "已置顶，置顶资料会排在学员列表最前");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${share.id}`);
      toast("分享链接已复制，学员登录后即可查看");
    } catch {
      toast("复制失败，请手动复制地址栏链接", "error");
    }
  }

  async function remove() {
    if (!confirm(`确定删除「${share.title}」吗？资料正文、附件与访问记录会一并删除，且无法恢复。`)) return;
    try {
      await api.post("/api/admin/shares/batch-delete", { ids: [share.id] });
      await mutate((k) => typeof k === "string" && k.startsWith("/api/admin/"));
      toast("资料已删除");
      navigate("/admin/shares", { replace: true });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <ShareDetailView
      data={data}
      backTo="/admin/shares"
      backLabel="分享资料"
      action={
        <>
          <Button variant="outline" onClick={copyLink}>
            <Share2 /> 复制链接
          </Button>
          <Button variant="outline" onClick={togglePin}>
            {share.pinned ? <PinOff /> : <Pin />} {share.pinned ? "取消置顶" : "置顶"}
          </Button>
          <Link to={`/admin/shares/${share.id}/edit`} className={buttonVariants({ variant: "outline" })}>
            <Pencil /> 编辑
          </Link>
          {share.status === "published" ? (
            <Button variant="outline" onClick={() => setStatus("archived")}>
              <Archive /> 归档
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setStatus("published")}>
              <RotateCcw /> 重新发布
            </Button>
          )}
          <Button variant="destructive-ghost" size="icon" onClick={remove} aria-label="删除资料" title="删除资料">
            <Trash2 />
          </Button>
        </>
      }
    />
  );
}
