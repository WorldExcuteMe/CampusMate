import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { AppearanceProvider } from "@/lib/theme";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        {children}
        <Toaster richColors position="top-center" />
      </AppearanceProvider>
    </QueryClientProvider>
  );
}