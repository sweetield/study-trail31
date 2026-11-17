import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, KeyRound } from "lucide-react";
import { useToast } from "./toast";
import { Button, Dialog } from "./ui";
import { todayStr } from "@/lib/utils";

export interface GeneratedAccountInfo {
  username: string;
  name: string;
  password: string;
  site_url: string;
}

function accountBlock(account: GeneratedAccountInfo, index: number, total: number) {
  const header = total > 1 ? `[${index}/${total}]学迹账号` : "学迹账号";
  const site = account.site_url || "（未填写）";
  return `${header}\n\n网址：${site}\n用户名：${account.username}\n密码：${account.password}`;
}

function accountsText(accounts: GeneratedAccountInfo[]) {
  return `${accounts.map((account, index) => accountBlock(account, index + 1, accounts.length)).join("\n\n——————\n\n")}\n`;
}

function saveBlob(name: string, blob: Blob) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function dateStamp() {
  return todayStr().replaceAll("-", "").slice(2);
}

/**
 * 添加 / 批量导入 / 批量重置密码后的账号信息页。
 * 复制或下载都不会关闭弹窗，只有管理员主动点击「关闭」才会退出。
 */
export function AccountInfoDialog({
  open,
  onClose,
  accounts,
  zipBase64,
  zipName,
  created,
  skipped,
  title = "账号信息",
  description,
  notice = "密码由系统随机生成，已直接写入账号，学员无需修改初始密码。",
}: {
  open: boolean;
  onClose: () => void;
  accounts: GeneratedAccountInfo[];
  zipBase64?: string;
  zipName?: string;
  created?: number;
  skipped?: number;
  /** 自定义标题，例如批量重置密码后显示「新的账号信息」 */
  title?: string;
  /** 自定义说明；不传时按创建的账号数量自动生成 */
  description?: string;
  /** 弹窗顶部的提示文案 */
  notice?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => accountsText(accounts), [accounts]);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast("账号信息已复制");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("复制失败，请手动选择文本", "error");
    }
  }

  function download() {
    if (zipBase64) {
      const bytes = base64ToBytes(zipBase64);
      saveBlob(zipName || `学迹账号_${dateStamp()}.zip`, new Blob([bytes], { type: "application/zip" }));
      toast("账号信息压缩包已开始下载");
      return;
    }
    const stamp = dateStamp();
    const name = accounts.length > 1 ? `学迹账号汇总_${stamp}.txt` : `${accounts[0]?.username ?? "学迹"}_学迹账号_${stamp}.txt`;
    saveBlob(name, new Blob([text], { type: "text/plain;charset=utf-8" }));
    toast("账号信息文档已开始下载");
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={false}
      title={title}
      description={
        description ??
        (typeof created === "number"
          ? `成功创建 ${created} 个账号${skipped ? `，跳过 ${skipped} 个重复或已存在的用户名` : ""}。请复制或下载保存，关闭后将无法再次查看密码。`
          : "账号已创建。请复制或下载保存，关闭后将无法再次查看密码。")
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 rounded-lg bg-primary-soft/50 px-3 py-2.5 text-sm text-foreground">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>{notice}</span>
        </div>

        <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">
          {accounts.map((account) => (
            <div key={account.username} className="px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{account.name}</span>
                <span className="text-xs text-muted-foreground">{account.username}</span>
              </div>
              <dl className="mt-1 grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">网址</dt>
                <dd className="truncate font-mono">{account.site_url || "（未填写）"}</dd>
                <dt className="text-muted-foreground">密码</dt>
                <dd className="font-mono break-all">{account.password}</dd>
              </dl>
            </div>
          ))}
        </div>

        <pre className="max-h-40 overflow-auto rounded-lg bg-muted px-3 py-2 text-xs whitespace-pre-wrap select-all">{text}</pre>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={copy}>
            {copied ? <Check /> : <Copy />} {copied ? "已复制" : "复制全部"}
          </Button>
          <Button variant="outline" onClick={download}>
            <Download /> {zipBase64 ? "下载压缩包" : "下载文档"}
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Dialog>
  );
}
