import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Providers } from "./app/providers";
import { AuthProvider } from "./app/auth";
import { SessionsProvider } from "./lib/agent/sessions-context";
import { AppRoutes } from "./app/routes";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <BrowserRouter>
        <AuthProvider>
          <SessionsProvider>
            <AppRoutes />
          </SessionsProvider>
        </AuthProvider>
      </BrowserRouter>
    </Providers>
  </StrictMode>,
);