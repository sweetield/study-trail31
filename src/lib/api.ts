export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "x-requested-with": "fetch",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `请求失败 (${res.status})`);
  return data as T;
}

async function uploadForm<T>(method: "POST" | "PUT", url: string, form: FormData): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "x-requested-with": "fetch" },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `上传失败 (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => request<T>("DELETE", url),
  upload: <T>(url: string, form: FormData) => uploadForm<T>("POST", url, form),
  /** 以 PUT 上传替换已有文件内容（图片编辑器保存 / 压缩） */
  replace: <T>(url: string, form: FormData) => uploadForm<T>("PUT", url, form),
  /** 下载文件（用于 Markdown 导出等），自动读取服务端文件名 */
  download: async (url: string, fallbackName = "download") => {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { "x-requested-with": "fetch" },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (data as { error?: string }).error ?? `下载失败 (${res.status})`);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    let name = fallbackName;
    try {
      name = decodeURIComponent(encoded?.[1] ?? plain?.[1] ?? fallbackName);
    } catch {
      name = plain?.[1] ?? fallbackName;
    }
    const href = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = href;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 部分浏览器在 click 后仍需短暂保留 Blob URL，延迟释放更稳妥
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    return res.headers;
  },
  /** POST 后下载服务端生成的文件（如批量导入学员的账号 ZIP） */
  downloadPost: async (url: string, body: unknown, fallbackName = "download") => {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-requested-with": "fetch", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (data as { error?: string }).error ?? `下载失败 (${res.status})`);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    let name = fallbackName;
    try {
      name = decodeURIComponent(encoded?.[1] ?? plain?.[1] ?? fallbackName);
    } catch {
      name = plain?.[1] ?? fallbackName;
    }
    const created = Number(res.headers.get("x-import-created") ?? 0);
    const skipped = Number(res.headers.get("x-import-skipped") ?? 0);
    const href = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = href;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    return { name, created, skipped };
  },
};

export const fetcher = <T>(url: string) => api.get<T>(url);
