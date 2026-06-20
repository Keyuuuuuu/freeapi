/* eslint-disable no-restricted-syntax, no-console */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React, { Suspense } from "react"
import ReactDOM from "react-dom/client"

import "~/utils/i18n"

import { RootErrorBoundary } from "~/components/RootErrorBoundary"
import { setupRuntimeMessageListeners } from "~/entrypoints/background/runtimeMessages"
import { initializeServices } from "~/entrypoints/background/servicesInit"
import { t } from "~/utils/i18n/core"
import { setDocumentTitle } from "~/utils/navigation/documentTitle"

import App from "./App"

setDocumentTitle("options")

const isWebMode =
  typeof (globalThis as any).chrome === "undefined" ||
  !(globalThis as any).chrome.runtime ||
  !(globalThis as any).chrome.runtime.onMessage ||
  (globalThis as any).chrome.runtime.id === "all-api-hub-web"

if (isWebMode) {
  setupRuntimeMessageListeners()
  initializeServices().catch((err) =>
    console.error("Failed to initialize background services in web mode:", err),
  )
}

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div>{t("common:status.loading")}</div>}>
          <App />
        </Suspense>
      </QueryClientProvider>
    </RootErrorBoundary>
  </React.StrictMode>,
)
