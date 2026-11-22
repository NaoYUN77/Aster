import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useThemeStore } from "@/store/theme";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  const resolvedTheme = useThemeStore((state) => state.resolved);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        position="bottom-center"
        theme={resolvedTheme}
        closeButton
        toastOptions={{
          classNames: {
            toast:
              "!rounded-2xl !border !border-border !bg-popover !text-popover-foreground !shadow-xl",
            description: "!text-muted-foreground",
            closeButton: "!bg-popover !text-muted-foreground !border-border",
          },
        }}
      />
    </QueryClientProvider>
  );
}
