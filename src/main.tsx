import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { SWRConfig } from "swr";
import { fetcher } from "@/lib/api";
import { ToastProvider } from "@/components/toast";
import { LightboxProvider } from "@/components/lightbox";
import { router } from "./router";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SWRConfig value={{ fetcher, dedupingInterval: 60_000, errorRetryCount: 2 }}>
      <ToastProvider>
        <LightboxProvider>
          <RouterProvider router={router} />
        </LightboxProvider>
      </ToastProvider>
    </SWRConfig>
  </StrictMode>,
);
