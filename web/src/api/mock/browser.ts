import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

export async function startMockWorker(): Promise<void> {
  await worker.start({
    onUnhandledFrame: "bypass",
    serviceWorker: { url: "/mockServiceWorker.js" },
    quiet: true,
  });
}
