import type { IncomingMessage, ServerResponse } from "node:http";
import { redirect, sendHtml } from "../../../infrastructure/http/html.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import { displayStylesheetHref } from "../../display/palette.ts";
import { type AdminContext, pageMessage, adminContext } from "./context.ts";
import { adminBreadcrumbs, adminNav } from "./layout.ts";
import type {
  RenderAdminNotFoundDependencies,
  RegisterAdminNotFoundDependencies,
} from "../contracts.ts";

export function renderAdminNotFound(
  dependencies: RenderAdminNotFoundDependencies,
  response: ServerResponse,
  request: IncomingMessage,
  context: AdminContext,
  pathname: string,
): void {
  const display = dependencies.displayService.getSettings();
  const breadcrumbs = adminBreadcrumbs(pathname, pathname, "Page not found");
  sendHtml(
    response,
    404,
    dependencies.renderer.render("/admin/not-found", {
      page: {
        title: "Page not found",
        path: pathname,
        breadcrumbs,
        csrfToken: context.csrfToken,
        siteName: display.tapboardName,
        displayStylesheetHref: displayStylesheetHref(display.theme, display.accent, display.font),
      },
      nav: adminNav(pathname, breadcrumbs),
      ...pageMessage(request),
    }),
  );
}

export function registerAdminNotFound(dependencies: RegisterAdminNotFoundDependencies): void {
  dependencies.router.setNotFoundHandler((request, response, pathname) => {
    if (!pathname.startsWith("/admin/")) {
      throw new ApplicationError({
        category: "not_found",
        code: "http.not_found",
        clientMessage: "Resource not found.",
      });
    }

    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      redirect(response, "/admin/login");
      return;
    }

    renderAdminNotFound(dependencies, response, request, context, pathname);
  });
}
