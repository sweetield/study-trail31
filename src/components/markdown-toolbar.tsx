import { useRef, useState, type ChangeEvent, type RefObject } from "react";
import { Bold, Code, Heading2, Italic, Link2, List, ListOrdered, Loader2, Paperclip, Quote, Strikethrough } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

const COLORS = [
  { label: "红色", value: "red", className: "bg-red-500" },
  { label: "橙色", value: "orange", className: "bg-orange-500" },
  { label: "绿色", value: "green", className: "bg-green-600" },
  { label: "蓝色", value: "blue", className: "bg-blue-600" },
  { label: "紫色", value: "purple", className: "bg-purple-600" },
] as const;

const FILE_ACCEPT = ".7z,.tar,.jpg,.jpeg,.png,.gif,.webp,.bmp,.avif";

export interface UploadSelection {
  start: number;
  end: number;
}

/**
 * 学习日志 / 任务说明 / 留言的 Markdown 快捷工具栏。
 *
 * 直接读写 textarea 的选区，然后通过 onChange 把新内容交还给受控组件；
 * 选中文字时包裹标记，未选中时插入占位文字并选中，方便直接继续输入。
 * 传入 onUploadFiles 后会显示“插入附件”按钮，由调用方完成上传并插入正文。
 */
export function MarkdownToolbar({
  target,
  onChange,
  onUploadFiles,
  disabled,
  className,
}: {
  target: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onUploadFiles?: (files: File[], selection: UploadSelection) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<UploadSelection>({ start: 0, end: 0 });
  const [uploading, setUploading] = useState(false);

  function focusSelection(start: number, end = start) {
    requestAnimationFrame(() => {
      const el = target.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
    });
  }

  function wrap(before: string, after: string, placeholder: string) {
    if (disabled) return;
    const el = target.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = el.value.slice(start, end);
    const text = selected || placeholder;
    const next = `${el.value.slice(0, start)}${before}${text}${after}${el.value.slice(end)}`;
    onChange(next);
    const innerStart = start + before.length;
    focusSelection(innerStart, selected ? innerStart + selected.length : innerStart + text.length);
  }

  function prefixLines(prefix: string) {
    if (disabled) return;
    const el = target.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = el.value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = el.value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? el.value.length : lineEndIndex;
    const block = el.value.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const nextBlock = lines.map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`)).join("\n");
    const next = `${el.value.slice(0, lineStart)}${nextBlock}${el.value.slice(lineEnd)}`;
    onChange(next);
    focusSelection(lineStart + prefix.length, lineStart + nextBlock.length);
  }

  function addLink() {
    if (disabled) return;
    const el = target.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = el.value.slice(start, end) || "链接文字";
    const snippet = `[${selected}](https://)`;
    const next = `${el.value.slice(0, start)}${snippet}${el.value.slice(end)}`;
    onChange(next);
    // 选中 https:// 方便直接替换成真实链接
    const urlStart = start + selected.length + 3;
    focusSelection(urlStart, urlStart + 8);
  }

  function openPicker() {
    if (disabled || uploading || !onUploadFiles) return;
    const el = target.current;
    // 文件选择框弹出后 textarea 会失焦，先记住当前选区，上传完成后仍然插入到原位置
    selectionRef.current = el ? { start: el.selectionStart, end: el.selectionEnd } : { start: 0, end: 0 };
    fileInputRef.current?.click();
  }

  async function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !onUploadFiles) return;
    setUploading(true);
    try {
      await onUploadFiles(files, selectionRef.current);
    } finally {
      setUploading(false);
    }
  }

  const tools = [
    { label: "加粗", icon: Bold, run: () => wrap("**", "**", "加粗文字") },
    { label: "斜体", icon: Italic, run: () => wrap("*", "*", "斜体文字") },
    { label: "删除线", icon: Strikethrough, run: () => wrap("~~", "~~", "删除线文字") },
    { label: "行内代码", icon: Code, run: () => wrap("`", "`", "代码") },
    { label: "二级标题", icon: Heading2, run: () => prefixLines("## ") },
    { label: "无序列表", icon: List, run: () => prefixLines("- ") },
    { label: "有序列表", icon: ListOrdered, run: () => prefixLines("1. ") },
    { label: "引用", icon: Quote, run: () => prefixLines("> ") },
    { label: "插入链接", icon: Link2, run: addLink },
  ];

  return (
    <div className={cn("flex flex-wrap items-center gap-0.5 rounded-lg border bg-muted/30 p-1", className)} role="toolbar" aria-label="Markdown 格式工具">
      {tools.map(({ label, icon: Icon, run }) => (
        <Button key={label} type="button" size="icon" variant="ghost" className="size-8" onClick={run} disabled={disabled} title={label} aria-label={label}>
          <Icon className="size-4" />
        </Button>
      ))}
      {onUploadFiles && (
        <>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={openPicker}
            disabled={disabled || uploading}
            title="从本地选择图片或 7z / tar 压缩包并插入正文（分卷可拖入）"
            aria-label="插入附件"
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </Button>
          <input ref={fileInputRef} type="file" multiple accept={FILE_ACCEPT} className="hidden" onChange={onPicked} tabIndex={-1} />
        </>
      )}
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <span className="flex items-center gap-1 px-0.5" role="group" aria-label="文字颜色">
        {COLORS.map((color) => (
          <button
            key={color.value}
            type="button"
            disabled={disabled}
            onClick={() => wrap(`<font color="${color.value}">`, "</font>", "彩色文字")}
            className={cn(
              "size-4 rounded-full border ring-offset-1 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              color.className,
            )}
            title={`${color.label}标记`}
            aria-label={`${color.label}标记`}
          />
        ))}
      </span>
    </div>
  );
}
