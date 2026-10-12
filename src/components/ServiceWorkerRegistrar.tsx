"use client";
// Registers the service worker (offline app shell + push). Renders nothing; lives in the root layout.
import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/client/sw-register";

export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return null;
}

export default ServiceWorkerRegistrar;
