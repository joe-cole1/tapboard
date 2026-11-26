import { readFormBody } from "../../../infrastructure/http/form.ts";
import { redirect, sendHtml } from "../../../infrastructure/http/html.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import { adminFailureMessage, reportFailure } from "../../../shared/diagnostics.ts";
import { ADMIN_THEME_COLORS, displayStylesheetHref } from "../../display/palette.ts";
import type { EventType } from "../../events/types.ts";
import type { OutboundService } from "../../outbound/service.ts";
import {
  validateHeaderSecretValue,
  validateHomeAssistantToken,
} from "../../outbound/outbound-validation.ts";
import type {
  CreateOutboundDestinationInput,
  OutboundDeliveryHistoryItem,
  OutboundDestination,
  OutboundHeader,
  OutboundHeadersInput,
  OutboundSecretHeaderInput,
  OutboundSettingsInput,
  OutboundTransport,
} from "../../outbound/types.ts";
import type { BrewfatherStatus } from "../../beverages/service.ts";
import type { TelemetryService } from "../../telemetry/service.ts";
import {
  autosaveFieldStrings,
  registerAdminAction,
  registerAdminGet,
  validationFieldsFor,
} from "./http.ts";
import { adminBreadcrumbs, adminNav, adminTabs, renderAdmin } from "./layout.ts";
import { requestUrl, actor, adminContext, messageLocation, type AdminContext } from "./context.ts";
import {
  filterForm,
  timestampLabel,
  numberedPageNavigation,
  type AutosaveForm,
  type PageHeader,
  type PageNavigation,
} from "./presentation.ts";
import { invalidForm } from "./forms.ts";
import { humanizeAdminIdentifier } from "./detector-presentation.ts";
import { telemetryDisableBlockers } from "./blockers.ts";
import { tapPagePath } from "./tap-detail.ts";
import type {
  RegisterIntegrationPagesDependencies,
  RegisterOutboundMutationsDependencies,
  RegisterIntegrationMutationsDependencies,
  RequireOutboundServiceDependencies,
  MachineKeyPageDataDependencies,
} from "../contracts.ts";

const OUTBOUND_CRUMB = {
  label: "Outbound delivery",
  href: "/admin/integrations/outbound",
} as const;
const TELEMETRY_CRUMB = { label: "Telemetry", href: "/admin/integrations/telemetry" } as const;

export function registerIntegrationPages(dependencies: RegisterIntegrationPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/integrations", (request, response, context) => {
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    const sources = dependencies.telemetryService.listSources();
    const outboundItems = dependencies.outboundService?.listPage() ?? [];
    const activeCount = sources.filter((source) => source.disabledAt === null).length;
    const enabledCount = outboundItems.filter(
      (item) => item.retiredAt === null && item.enabled,
    ).length;
    const outboundAvailable = dependencies.outboundService !== undefined;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations",
      "Integrations",
      "/admin/integrations",
      {
        tabs: adminTabs("integrations", "/admin/integrations"),
        telemetry: {
          activeCount,
          disabledCount: sources.filter((source) => source.disabledAt !== null).length,
          badge:
            activeCount > 0
              ? { label: `${activeCount} active`, tone: "healthy" }
              : { label: "Not configured", tone: "muted" },
        },
        brewfather: {
          configured: brewfather.configured,
          enabled: brewfather.account?.enabled ?? false,
          apiKeyConfigured: brewfather.apiKeyConfigured,
          linkedBeverages: brewfather.totalLinkedBeverages,
          candidates: brewfather.totalCandidates,
          badge: brewfatherConnectionBadge(brewfather),
          summary: !brewfather.apiKeyConfigured
            ? "Add an API key to import and refresh beverage data."
            : brewfather.account?.enabled === true
              ? "Beverage data is available for linking."
              : "Sync is off. Linked beverages keep their last Brewfather data.",
        },
        outbound: {
          available: outboundAvailable,
          count: outboundItems.filter((item) => item.retiredAt === null).length,
          enabledCount,
          badge: outboundAvailable
            ? { label: `${enabledCount} enabled`, tone: enabledCount > 0 ? "healthy" : "muted" }
            : { label: "Unavailable", tone: "muted" },
          requiredCount: outboundItems.filter((item) => item.retiredAt === null && item.required)
            .length,
        },
      },
    );
  });

  registerAdminGet(dependencies, "/admin/integrations/outbound", (request, response, context) => {
    const destinations = dependencies.outboundService?.listPage() ?? [];
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations-outbound",
      "Outbound delivery",
      "/admin/integrations/outbound",
      {
        tabs: adminTabs("integrations", "/admin/integrations/outbound"),
        available: dependencies.outboundService !== undefined,
        destinations: destinations.map((destination) =>
          outboundDestinationPresentation(destination),
        ),
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/integrations/outbound/new",
    (request, response, context) => {
      const requested = requestUrl(request).searchParams.get("transport");
      const transport = requested === "webhook" ? "webhook" : "home_assistant";
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-outbound-new",
        "New outbound destination",
        "/admin/integrations/outbound/new",
        {
          breadcrumbParents: [OUTBOUND_CRUMB],
          available: dependencies.outboundService !== undefined,
          transport,
          eventFields: OUTBOUND_EVENT_FIELDS,
          maxHeaderRows: OUTBOUND_MAX_HEADER_ROWS,
        },
      );
    },
  );

  registerAdminGet(
    dependencies,
    "/admin/integrations/outbound/:id",
    (request, response, context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const history = outboundHistoryPresentation(
        service.listDeliveries(destination.id, 100),
        destination.retiredAt === null,
      );
      const presentation = outboundDestinationPresentation(destination);
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-outbound-detail",
        destination.label,
        `/admin/integrations/outbound/${encodeURIComponent(destination.id)}`,
        {
          breadcrumbParents: [OUTBOUND_CRUMB],
          header: {
            title: destination.label,
            titleField: "label",
            intro: `${destination.transport === "home_assistant" ? "Home Assistant" : "Webhook"} destination. Endpoint and credential values are never displayed.`,
          } satisfies PageHeader,
          available: true,
          destination: presentation,
          forms: outboundForms(destination.id, OUTBOUND_SETTINGS_FIELDS.join(",")),
          history,
          eventFields: OUTBOUND_EVENT_FIELDS,
          maxHeaderRows: OUTBOUND_MAX_HEADER_ROWS,
        },
      );
    },
  );

  registerAdminGet(dependencies, "/admin/integrations/brewfather", (request, response, context) => {
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations-brewfather",
      "Brewfather",
      "/admin/integrations/brewfather",
      {
        tabs: adminTabs("integrations", "/admin/integrations/brewfather"),
        brewfather: {
          configured: brewfather.configured,
          enabled: brewfather.account?.enabled ?? false,
          updatedAt: brewfather.account?.updatedAt ?? "",
          badge: brewfatherConnectionBadge(brewfather),
          apiKeyConfigured: brewfather.apiKeyConfigured,
          linkedBeverages: brewfather.totalLinkedBeverages,
          candidates: brewfather.totalCandidates,
          lastDataUpdateAt: brewfather.lastDataUpdateAt,
          lastDataUpdateAtLabel: timestampLabel(brewfather.lastDataUpdateAt),
          connectionState: brewfather.connectionState,
          credentialStorage: brewfather.credentialStorage,
        },
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/integrations/telemetry/new",
    (request, response, context) => {
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-telemetry-new",
        "New telemetry source",
        "/admin/integrations/telemetry/new",
        { breadcrumbParents: [TELEMETRY_CRUMB] },
      );
    },
  );

  registerAdminGet(dependencies, "/admin/integrations/telemetry", (request, response, context) => {
    const params = requestUrl(request).searchParams;
    const requestedQuery = (params.get("q") ?? "").trim().slice(0, 80);
    const parsePage = (value: string | null): number => {
      const page = Number(value ?? "1");
      return Number.isInteger(page) && Number.isFinite(page)
        ? Math.min(10_000, Math.max(1, page))
        : 1;
    };
    const activePageNumber = parsePage(params.get("activePage"));
    const historyPageNumber = parsePage(params.get("historyPage"));
    const activePage = dependencies.telemetryService.listAdminSourcePage({
      q: requestedQuery,
      state: "active",
      page: activePageNumber,
    });
    const historyPage = dependencies.telemetryService.listAdminSourcePage({
      q: requestedQuery,
      state: "disabled",
      page: historyPageNumber,
    });
    const query = activePage.query;
    const mapSource = (source: ReturnType<TelemetryService["listSources"]>[number]) => ({
      id: source.id,
      name: source.name,
      keyPublicId: source.currentMachineKey.publicId,
      keyCreatedAt: source.currentMachineKey.createdAt,
      keyCreatedAtLabel: timestampLabel(source.currentMachineKey.createdAt),
      createdAt: source.createdAt,
      createdAtLabel: timestampLabel(source.createdAt),
      disabledAt: source.disabledAt,
      disabledAtLabel: timestampLabel(source.disabledAt),
    });
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations-telemetry",
      "Telemetry",
      "/admin/integrations/telemetry",
      {
        tabs: adminTabs("integrations", "/admin/integrations/telemetry"),
        activeSources: activePage.items.map(mapSource),
        disabledSources: historyPage.items.map(mapSource),
        filter: filterForm({
          action: "/admin/integrations/telemetry",
          label: "Search telemetry sources",
          search: { value: query ?? "", placeholder: "Source name or ID" },
        }),
        activePages: telemetryPageNavigation("Active telemetry source pages", activePage, (page) =>
          telemetryPageHref(query, page, historyPage.page, "active"),
        ),
        historyPages: telemetryPageNavigation(
          "Disabled telemetry source pages",
          historyPage,
          (page) => telemetryPageHref(query, activePage.page, page, "history"),
        ),
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/integrations/telemetry-sources/:id",
    (request, response, context, params) => {
      const source = dependencies.telemetryService
        .listSources()
        .find((candidate) => candidate.id === params.id);
      if (source === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "telemetry.source_not_found",
          clientMessage: "Telemetry source was not found.",
        });
      }
      const tapsById = new Map(dependencies.tapService.listTaps().map((tap) => [tap.id, tap]));
      const usingTaps = dependencies.telemetryService
        .listAuthorities()
        .filter((authority) =>
          [authority.level, authority.condition, authority.flow].some(
            (role) => role?.sourceId === source.id,
          ),
        )
        .flatMap((authority) => {
          const tap = tapsById.get(authority.tapId);
          return tap === undefined ? [] : [tap];
        })
        .sort((left, right) => left.tapNumber - right.tapNumber)
        .map((tap) => ({ tapNumber: tap.tapNumber, sensorsHref: tapPagePath(tap.id, "sensors") }));
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-telemetry-source",
        source.name,
        `/admin/integrations/telemetry-sources/${encodeURIComponent(source.id)}`,
        {
          breadcrumbParents: [TELEMETRY_CRUMB],
          disableBlockers: telemetryDisableBlockers(usingTaps),
          source: {
            id: source.id,
            name: source.name,
            keyPublicId: source.currentMachineKey.publicId,
            keyCreatedAt: source.currentMachineKey.createdAt,
            keyCreatedAtLabel: timestampLabel(source.currentMachineKey.createdAt),
            createdAt: source.createdAt,
            createdAtLabel: timestampLabel(source.createdAt),
            disabledAt: source.disabledAt,
            disabledAtLabel: timestampLabel(source.disabledAt),
            badge:
              source.disabledAt === null
                ? { label: "Active", tone: "healthy" }
                : { label: "Disabled", tone: "muted" },
          },
        },
      );
    },
  );
}

export function registerOutboundMutations(
  dependencies: RegisterOutboundMutationsDependencies,
): void {
  const destinationFor = (params: Readonly<Record<string, string>>): OutboundDestination =>
    outboundDestinationOrNotFound(requireOutboundService(dependencies), params.id ?? "");

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/create",
    "/admin/integrations/outbound",
    (form) => {
      requireOutboundService(dependencies).create(outboundCreateFromForm(form));
    },
    "Outbound destination created.",
    { maxBytes: 16_384, maxFields: 100 },
  );

  const saveSettings = (
    form: Readonly<Record<string, string>>,
    params: Readonly<Record<string, string>>,
  ): OutboundDestination => {
    const destination = destinationFor(params);
    return requireOutboundService(dependencies).updateSettings(
      destination.id,
      outboundSettingsFromForm(form, destination.transport),
    );
  };
  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/settings",
    outboundDestinationPath,
    (form, _context, params) => {
      saveSettings(form, params);
    },
    "Outbound settings saved.",
    {},
    {
      // The service checks no revision, so this answers with the destination's current one.
      handle: (body, _context, params) => {
        const saved = saveSettings(autosaveFieldStrings(body, OUTBOUND_SETTINGS_FIELDS), params);
        return { resource: outboundSettingsResource(saved), revision: saved.updatedAt };
      },
      current: (params) => {
        const destination = destinationFor(params);
        return { current: outboundSettingsResource(destination), revision: destination.updatedAt };
      },
      validationFields: validationFieldsFor(OUTBOUND_SETTINGS_FIELDS),
    },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/endpoint",
    outboundDestinationPath,
    (form, _context, params) => {
      const url = (form.url ?? "").trim();
      if (url === "") invalidForm("Enter the new address.", "url");
      requireOutboundService(dependencies).changeEndpoint(params.id ?? "", {
        url,
        ...outboundTokenFromForm(form),
      });
    },
    "Endpoint changed.",
    { maxBytes: 16_384, maxFields: 20 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/headers",
    outboundDestinationPath,
    (form, _context, params) => {
      const destination = destinationFor(params);
      requireOutboundService(dependencies).replaceHeaders(
        destination.id,
        outboundHeadersFromForm(form, destination),
      );
    },
    "Headers saved.",
    { maxBytes: 16_384, maxFields: 100 },
  );

  // One-click switches: each posts the value it changes to.
  const saveEnabled = (
    form: Readonly<Record<string, string>>,
    params: Readonly<Record<string, string>>,
  ): OutboundDestination =>
    requireOutboundService(dependencies).setEnabled(
      params.id ?? "",
      switchValue(form, "enabled", "delivery"),
    );
  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/enabled",
    outboundDestinationPath,
    (form, _context, params) => {
      saveEnabled(form, params);
    },
    "Delivery setting updated.",
    {},
    {
      handle: (body, _context, params) => {
        const saved = saveEnabled(autosaveFieldStrings(body, ["enabled"]), params);
        return { resource: outboundEnabledResource(saved), revision: saved.updatedAt };
      },
      current: (params) => {
        const destination = destinationFor(params);
        return { current: outboundEnabledResource(destination), revision: destination.updatedAt };
      },
      validationFields: validationFieldsFor(["enabled"]),
    },
  );

  const saveRequired = (
    form: Readonly<Record<string, string>>,
    params: Readonly<Record<string, string>>,
  ): OutboundDestination =>
    requireOutboundService(dependencies).setRequired(
      params.id ?? "",
      switchValue(form, "required", "Required"),
    );
  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/required",
    outboundDestinationPath,
    (form, _context, params) => {
      saveRequired(form, params);
    },
    "Required-delivery setting updated.",
    {},
    {
      handle: (body, _context, params) => {
        const saved = saveRequired(autosaveFieldStrings(body, ["required"]), params);
        return { resource: { required: saved.required }, revision: saved.updatedAt };
      },
      current: (params) => {
        const destination = destinationFor(params);
        return { current: { required: destination.required }, revision: destination.updatedAt };
      },
      validationFields: validationFieldsFor(["required"]),
    },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/token",
    outboundDestinationPath,
    (form, _context, params) => {
      const token = form.token ?? "";
      if (token === "") invalidForm("A replacement Home Assistant token is required.", "token");
      requireOutboundService(dependencies).setToken(params.id ?? "", token);
    },
    "Home Assistant token replaced.",
    { maxBytes: 16_384, maxFields: 20 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/token/remove",
    outboundDestinationPath,
    (_form, _context, params) => {
      requireOutboundService(dependencies).removeToken(params.id ?? "");
    },
    "Home Assistant token removed and delivery disabled.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/header-secret",
    outboundDestinationPath,
    (form, _context, params) => {
      const slot = (form.slot ?? "").trim();
      const secret = form.secret ?? "";
      if (slot === "" || secret === "") invalidForm("A header secret replacement is required.");
      requireOutboundService(dependencies).setHeaderSecret(params.id ?? "", slot, secret);
    },
    "Header secret replaced.",
    { maxBytes: 16_384, maxFields: 20 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/header-secret/remove",
    outboundDestinationPath,
    (form, _context, params) => {
      const slot = (form.slot ?? "").trim();
      if (slot === "") invalidForm("A header secret slot is required.");
      requireOutboundService(dependencies).removeHeaderSecret(params.id ?? "", slot);
    },
    "Header secret removed and delivery disabled.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/retire",
    "/admin/integrations/outbound",
    (_form, _context, params) => {
      requireOutboundService(dependencies).retire(params.id ?? "");
    },
    "Outbound destination retired.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/deliveries/:deliveryId/retry",
    outboundDestinationPath,
    (_form, _context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const delivery = service
        .listDeliveries(destination.id, 100)
        .find((item) => item.id === params.deliveryId);
      if (delivery === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "outbound.delivery_not_found",
          clientMessage: "Delivery history item not found.",
        });
      }
      if (!service.retryDelivery(destination.id, delivery.id)) {
        throw new ApplicationError({
          category: "conflict",
          code: "outbound.delivery_not_retryable",
          clientMessage: "That delivery is no longer waiting for retry.",
        });
      }
    },
    "Delivery scheduled for retry.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/deliveries/:deliveryId/dismiss",
    outboundDestinationPath,
    (_form, _context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const delivery = service
        .listDeliveries(destination.id, 100)
        .find((item) => item.id === params.deliveryId);
      if (delivery === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "outbound.delivery_not_found",
          clientMessage: "Delivery history item not found.",
        });
      }
      if (!service.dismissDelivery(destination.id, delivery.id)) {
        throw new ApplicationError({
          category: "conflict",
          code: "outbound.delivery_not_dismissible",
          clientMessage: "That delivery is no longer open for dismissal.",
        });
      }
    },
    "Delivery dismissed.",
  );
}

export function registerIntegrationMutations(
  dependencies: RegisterIntegrationMutationsDependencies,
): void {
  // The User ID and API key identify one account, so they change together; the account keeps
  // its Enabled setting and discovery statuses.
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather",
    "/admin/integrations/brewfather",
    (form, context) => {
      const account = dependencies.beverageService.getBrewfatherStatus().account;
      dependencies.beverageService.configureBrewfatherAccount(
        {
          userId: form.userId,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          ...(account === undefined
            ? {}
            : { enabled: account.enabled, discoveryStatuses: account.discoveryStatuses }),
        },
        actor(context),
      );
    },
    "Brewfather account saved. Stored secrets are never displayed.",
  );
  const saveBrewfatherEnabled = (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
  ): { readonly enabled: boolean; readonly updatedAt: string } => {
    const account = dependencies.beverageService.getBrewfatherStatus().account;
    if (account === undefined) invalidForm("Save the Brewfather account first.", "enabled");
    return dependencies.beverageService.configureBrewfatherAccount(
      {
        userId: account.userId,
        enabled: switchValue(form, "enabled", "Brewfather sync"),
        discoveryStatuses: account.discoveryStatuses,
      },
      actor(context),
    );
  };
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/enabled",
    "/admin/integrations/brewfather",
    (form, context) => {
      saveBrewfatherEnabled(form, context);
    },
    "Brewfather sync setting updated.",
    {},
    {
      // The account keeps no revision check, so this answers with its current one.
      handle: (body, context) => {
        const saved = saveBrewfatherEnabled(autosaveFieldStrings(body, ["enabled"]), context);
        const badge = brewfatherConnectionBadge(dependencies.beverageService.getBrewfatherStatus());
        return {
          resource: {
            enabled: saved.enabled,
            statusLabel: badge.label,
            statusClass: badge.tone,
          },
          revision: saved.updatedAt,
        };
      },
      current: () => {
        const account = dependencies.beverageService.getBrewfatherStatus().account;
        return {
          current: { enabled: account?.enabled ?? false },
          ...(account === undefined ? {} : { revision: account.updatedAt }),
        };
      },
      validationFields: validationFieldsFor(["enabled"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/sync",
    "/admin/integrations/brewfather",
    async (_form, _context) => {
      const results = await dependencies.beverageService.syncBrewfather();
      const failed = results.find(
        (result) =>
          result.error !== undefined ||
          result.authenticationFailed ||
          result.linkedErrors > 0 ||
          (result.failures?.length ?? 0) > 0,
      );
      if (failed !== undefined) {
        const failure = failed.failures?.[0];
        throw new ApplicationError({
          category: failure?.category ?? "unavailable",
          code: failure?.code ?? "brewfather.sync_failed",
          clientMessage: `Brewfather refresh incomplete. ${failure?.message ?? "The provider could not complete the refresh. Try again later."}`,
          ...(failure
            ? {
                details: {
                  providerStatus: failure.providerStatus,
                  retryAfterMs: failure.retryAfterMs,
                },
              }
            : {}),
        });
      }
      if (results.length === 0 || results.some((result) => result.connectionVerified !== true)) {
        return {
          notice:
            "Brewfather was not verified. Enable a configured account and try the refresh again.",
        };
      }
    },
    "Brewfather refresh completed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/remove-key",
    "/admin/integrations/brewfather",
    (_form, context) => {
      dependencies.beverageService.removeBrewfatherApiKey("default", actor(context));
    },
    "Brewfather API key removed.",
  );

  dependencies.router.post(
    "/admin/integrations/telemetry-sources/create",
    async (request, response) => {
      const context = adminContext(request, dependencies.authService);
      let committed = false;
      try {
        if (context === undefined)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const form = await readFormBody(request);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const issued = dependencies.telemetryService.createSource(
          { name: form.name },
          actor(context),
        );
        committed = true;
        sendHtml(
          response,
          200,
          dependencies.renderer.render(
            "/admin/machine-key",
            machineKeyPageData(
              dependencies,
              context,
              "Telemetry key created",
              issued.source.name,
              issued.initialToken,
            ),
          ),
        );
      } catch (error) {
        if (response.headersSent) throw error;
        const failure = reportFailure(error, {
          operation: "admin.telemetry.create",
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        });
        redirect(
          response,
          messageLocation(
            committed ? "/admin/integrations/telemetry" : "/admin/integrations/telemetry/new",
            "error",
            context === undefined
              ? "The form could not be authorized. Reload and try again."
              : committed
                ? adminFailureMessage(
                    {
                      ...failure,
                      expected: true,
                      message:
                        "Telemetry source and key created, but the token could not be shown. Rotate the key again to get a replacement; rotation invalidates the previous key.",
                    },
                    "",
                  )
                : adminFailureMessage(failure, "Telemetry source could not be created."),
          ),
        );
      }
    },
  );
  dependencies.router.post(
    "/admin/integrations/telemetry-sources/:id/rotate",
    async (request, response, params) => {
      const context = adminContext(request, dependencies.authService);
      let committed = false;
      try {
        if (context === undefined)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const form = await readFormBody(request);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const issued = dependencies.telemetryService.rotateSourceKey(
          params.id!,
          {},
          actor(context),
        );
        committed = true;
        sendHtml(
          response,
          200,
          dependencies.renderer.render(
            "/admin/machine-key",
            machineKeyPageData(
              dependencies,
              context,
              "Telemetry key rotated",
              issued.source.name,
              issued.replacementToken,
            ),
          ),
        );
      } catch (error) {
        if (response.headersSent) throw error;
        const failure = reportFailure(error, {
          operation: "admin.telemetry.rotate",
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        });
        redirect(
          response,
          messageLocation(
            "/admin/integrations/telemetry",
            "error",
            context === undefined
              ? "The form could not be authorized. Reload and try again."
              : committed
                ? adminFailureMessage(
                    {
                      ...failure,
                      expected: true,
                      message:
                        "Telemetry key rotated, but the token could not be shown. Rotate the key again to get a replacement; rotation invalidates the previous key.",
                    },
                    "",
                  )
                : adminFailureMessage(failure, "Telemetry key could not be rotated."),
          ),
        );
      }
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/telemetry-sources/:id/disable",
    "/admin/integrations/telemetry",
    (_form, context, params) => {
      dependencies.telemetryService.disableSource(params.id!, actor(context));
    },
    "Telemetry source disabled and its current key revoked.",
  );
}

export function telemetryEndpointUrl(canonicalOrigin: string | undefined): string {
  const origin = (canonicalOrigin ?? "http://localhost:3000").replace(/\/+$/u, "");
  return `${origin}/api/v1/telemetry/taps/1`;
}

export const OUTBOUND_EVENT_FIELDS = [
  { eventType: "fill.assigned", name: "subscription_fill_assigned", label: "Fill assigned" },
  { eventType: "fill.ended", name: "subscription_fill_ended", label: "Fill ended" },
  { eventType: "pour.completed", name: "subscription_pour_completed", label: "Pour completed" },
  { eventType: "keg.low", name: "subscription_keg_low", label: "Keg low" },
  {
    eventType: "health.transitioned",
    name: "subscription_health_transitioned",
    label: "Health transitioned",
  },
  {
    eventType: "integration.status_changed",
    name: "subscription_integration_status_changed",
    label: "Integration status changed",
  },
] as const satisfies readonly {
  readonly eventType: EventType;
  readonly name: string;
  readonly label: string;
}[];

export const OUTBOUND_MAX_HEADER_ROWS = 8;

/** The live Settings form on a destination's page. */
const OUTBOUND_SETTINGS_FIELDS = [
  "label",
  ...OUTBOUND_EVENT_FIELDS.map((field) => field.name),
  "payloadFormat",
  "allowPrivateNetwork",
];

/** A one-click switch posts the value it changes to: "true" or "false". */
function switchValue(
  form: Readonly<Record<string, string>>,
  field: string,
  label: string,
): boolean {
  if (form[field] !== "true" && form[field] !== "false") {
    invalidForm(`Choose On or Off for ${label}.`, field);
  }
  return form[field] === "true";
}

export function outboundDestinationPath(params: Readonly<Record<string, string>>): string {
  return `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`;
}

/** The Settings form's saved values: never an endpoint, header value or token. */
function outboundSettingsResource(destination: OutboundDestination): Record<string, unknown> {
  const config = destination.currentVersion?.config;
  return {
    label: destination.label,
    // Shown in the page header and Status card, which a save updates in place.
    versionNumber: String(destination.currentVersion?.versionNumber ?? "—"),
    ...Object.fromEntries(
      OUTBOUND_EVENT_FIELDS.map((field) => [
        field.name,
        destination.subscriptions.includes(field.eventType),
      ]),
    ),
    ...(config?.transport === "webhook"
      ? { payloadFormat: config.payloadFormat, allowPrivateNetwork: config.allowPrivateNetwork }
      : {}),
  };
}

/** The Enabled switch's value, with the Status card's badge and reason that follow it. */
function outboundEnabledResource(destination: OutboundDestination): Record<string, unknown> {
  const status = outboundStatusBadge(destination);
  return {
    enabled: destination.enabled,
    statusLabel: status.label,
    statusClass: status.tone,
    disabledNote:
      destination.disabledReason === null || destination.enabled
        ? ""
        : `Disabled: ${outboundStateLabel(destination.disabledReason)}`,
  };
}

const BREWFATHER_CONNECTION_LABELS: Readonly<Record<string, string>> = {
  healthy: "Connected",
  unknown: "Awaiting verification",
  partial: "Refresh incomplete",
  disconnected: "Disconnected",
};

/** The live-saving parts of an outbound destination's page. */
function outboundForms(id: string, settingsFields: string): Readonly<Record<string, AutosaveForm>> {
  const base = `/admin/integrations/outbound/${encodeURIComponent(id)}`;
  const resource = `outbound:${id}`;
  return {
    enabled: { action: `${base}/enabled`, mode: "submit", resource, fields: "enabled" },
    required: { action: `${base}/required`, mode: "submit", resource, fields: "required" },
    settings: { action: `${base}/settings`, mode: "blur", resource, fields: settingsFields },
  };
}

/** The telemetry list keeps both page numbers in its links; the changing one comes first. */
function telemetryPageHref(
  query: string | undefined,
  activePage: number,
  historyPage: number,
  changing: "active" | "history",
): string {
  const q = `q=${encodeURIComponent(query || "")}`;
  return changing === "active"
    ? `/admin/integrations/telemetry?${q}&activePage=${activePage}&historyPage=${historyPage}`
    : `/admin/integrations/telemetry?${q}&historyPage=${historyPage}&activePage=${activePage}`;
}

function telemetryPageNavigation(
  label: string,
  page: { readonly page: number; readonly pageCount: number },
  href: (page: number) => string,
): PageNavigation | null {
  if (page.pageCount <= 1) return null;
  return numberedPageNavigation(
    label,
    page.page,
    page.pageCount,
    page.page > 1 ? href(page.page - 1) : null,
    page.page < page.pageCount ? href(page.page + 1) : null,
  );
}

/**
 * The one Brewfather status word, shown on Overview, the Integrations card and the Brewfather
 * page: Not configured, Disabled, API key required, Awaiting verification, Connected, Refresh
 * incomplete or Disconnected.
 */
export function brewfatherConnectionBadge(status: BrewfatherStatus): {
  readonly label: string;
  readonly tone: "healthy" | "degraded" | "muted";
} {
  if (!status.configured) return { label: "Not configured", tone: "muted" };
  if (status.account?.enabled !== true) return { label: "Disabled", tone: "muted" };
  if (!status.apiKeyConfigured) return { label: "API key required", tone: "degraded" };
  const label = BREWFATHER_CONNECTION_LABELS[status.connectionState] ?? "Awaiting verification";
  return {
    label,
    tone:
      label === "Connected" ? "healthy" : label === "Awaiting verification" ? "muted" : "degraded",
  };
}

export function outboundStatusBadge(destination: OutboundDestination): {
  readonly label: string;
  readonly tone: "healthy" | "degraded" | "muted";
} {
  if (destination.retiredAt !== null) return { label: "Retired", tone: "muted" };
  if (!destination.enabled) return { label: "Disabled", tone: "muted" };
  return {
    label: outboundStateLabel(destination.state),
    tone: outboundStateClass(destination.state),
  };
}

export function requireOutboundService(
  dependencies: RequireOutboundServiceDependencies,
): OutboundService {
  const service = dependencies.outboundService;
  if (service === undefined) {
    throw new ApplicationError({
      category: "unavailable",
      code: "outbound.unavailable",
      clientMessage: "Outbound integrations are not available in this application.",
    });
  }
  return service;
}

export function outboundDestinationOrNotFound(
  service: OutboundService,
  destinationId: string,
): OutboundDestination {
  const destination = service.get(destinationId);
  if (destination === undefined) {
    throw new ApplicationError({
      category: "not_found",
      code: "outbound.destination_not_found",
      clientMessage: "Outbound destination not found.",
    });
  }
  return destination;
}

export function outboundShortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-3)}` : value;
}

export function outboundStateLabel(value: string): string {
  return humanizeAdminIdentifier(value, "Unknown");
}

export function outboundStateClass(value: string): "healthy" | "degraded" | "muted" {
  if (value === "healthy") return "healthy";
  if (value === "failing" || value === "degraded" || value === "needs_attention") return "degraded";
  return "muted";
}

export function outboundConfigPresentation(
  destination: OutboundDestination,
): Record<string, unknown> {
  const version = destination.currentVersion;
  const config = version?.config;
  if (config === undefined) {
    return {
      available: false,
      transportLabel: humanizeAdminIdentifier(destination.transport),
      staticHeaders: [],
      secretHeaders: [],
    };
  }
  const isHa = config.transport === "home_assistant";
  const configured = isHa ? config.authConfigured : config.endpointConfigured;
  const available = isHa ? config.authAvailable : config.endpointAvailable;
  return {
    available: true,
    transportLabel: isHa ? "Home Assistant" : "Webhook",
    payloadFormat: isHa ? null : config.payloadFormat,
    allowPrivateNetwork: !isHa && config.allowPrivateNetwork,
    endpointConfigured: isHa ? config.authConfigured : config.endpointConfigured,
    endpointAvailable: isHa ? config.authAvailable : config.endpointAvailable,
    credentialStateLabel: available
      ? "Configured"
      : configured
        ? "Configured but unavailable"
        : isHa
          ? "Token not configured"
          : "Endpoint not configured",
    staticHeaders: config.staticHeaders.map((header) => ({ name: header.name })),
    secretHeaders: config.secretHeaders.map((header) => ({
      name: header.name,
      slot: header.slot,
      configured: header.configured,
      available: header.available === true,
    })),
  };
}

export function outboundDestinationPresentation(
  destination: OutboundDestination,
): Record<string, unknown> {
  const version = destination.currentVersion;
  return {
    id: destination.id,
    updatedAt: destination.updatedAt,
    label: destination.label,
    transport: destination.transport,
    transportLabel: destination.transport === "home_assistant" ? "Home Assistant" : "Webhook",
    badge: outboundStatusBadge(destination),
    subscriptions: destination.subscriptions,
    required: destination.required,
    enabled: destination.enabled,
    retired: destination.retiredAt !== null,
    state: destination.state,
    stateLabel: outboundStateLabel(destination.state),
    stateClass: outboundStateClass(destination.state),
    disabledReason:
      destination.disabledReason === null ? null : outboundStateLabel(destination.disabledReason),
    // The badge and reason the Enabled switch updates in place.
    ...outboundEnabledResource(destination),
    failure:
      destination.failure === null
        ? null
        : {
            code: destination.failure.code,
            failureClass: outboundStateLabel(destination.failure.failureClass),
            occurredAt: destination.failure.occurredAt,
            occurredAtLabel: timestampLabel(destination.failure.occurredAt),
          },
    lastSuccessAt: destination.lastSuccessAt,
    lastSuccessAtLabel:
      destination.lastSuccessAt === null
        ? "No confirmed success"
        : timestampLabel(destination.lastSuccessAt),
    version:
      version === null
        ? null
        : {
            id: version.id,
            versionNumber: version.versionNumber,
            createdAt: version.createdAt,
            createdAtLabel: timestampLabel(version.createdAt),
          },
    config: outboundConfigPresentation(destination),
  };
}

export function outboundHistoryPresentation(
  rows: readonly OutboundDeliveryHistoryItem[],
  mutable = true,
): readonly Record<string, unknown>[] {
  return rows.slice(0, 100).map((row) => ({
    id: row.id,
    shortId: outboundShortId(row.id),
    eventId: outboundShortId(row.eventId),
    eventType:
      OUTBOUND_EVENT_FIELDS.find((field) => field.eventType === row.eventType)?.label ??
      row.eventType,
    state: row.state,
    stateLabel: outboundStateLabel(row.state),
    badge: {
      label: outboundStateLabel(row.state),
      tone: row.state === "succeeded" ? "healthy" : row.state === "terminal" ? "degraded" : "muted",
    },
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lastAttemptAt: row.lastAttemptAt,
    lastAttemptAtLabel:
      row.lastAttemptAt === null ? "Not attempted" : timestampLabel(row.lastAttemptAt),
    nextAttemptAt: row.nextAttemptAt,
    nextAttemptAtLabel: timestampLabel(row.nextAttemptAt),
    canRetry: mutable && row.state === "terminal",
    canDismiss: mutable && row.state === "terminal",
  }));
}

export function outboundSubscriptionsFromForm(
  form: Readonly<Record<string, string>>,
): readonly EventType[] {
  return OUTBOUND_EVENT_FIELDS.filter((field) => form[field.name] === "on").map(
    (field) => field.eventType,
  );
}

/**
 * The filled-in static header rows. Values are never shown again, so a blank value keeps the
 * stored value of the header with that name.
 */
function outboundStaticHeadersFromForm(
  form: Readonly<Record<string, string>>,
  stored: readonly OutboundHeader[] = [],
): readonly OutboundHeader[] {
  const rows: OutboundHeader[] = [];
  for (let index = 0; index < OUTBOUND_MAX_HEADER_ROWS; index += 1) {
    const name = (form[`static_header_${index}_name`] ?? "").trim();
    const value = form[`static_header_${index}_value`] ?? "";
    if (name === "" && value.trim() === "") continue;
    const kept =
      value === ""
        ? stored.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value
        : undefined;
    rows.push({ name, value: kept ?? value });
  }
  return rows;
}

/** The filled-in secret header rows; a blank value keeps the stored one. */
function outboundSecretHeadersFromForm(
  form: Readonly<Record<string, string>>,
): readonly OutboundSecretHeaderInput[] {
  const rows: OutboundSecretHeaderInput[] = [];
  for (let index = 0; index < OUTBOUND_MAX_HEADER_ROWS; index += 1) {
    const name = (form[`secret_header_${index}_name`] ?? "").trim();
    const slot = (form[`secret_header_${index}_slot`] ?? "").trim();
    const value = form[`secret_header_${index}_value`] ?? "";
    if (name === "" && slot === "" && value.trim() === "") continue;
    rows.push({
      name,
      ...(slot === "" ? {} : { slot }),
      ...(value === "" ? {} : { value: validateHeaderSecretValue(value) }),
    });
  }
  return rows;
}

/** A submitted Home Assistant token, checked before it goes anywhere; blank keeps the stored one. */
function outboundTokenFromForm(form: Readonly<Record<string, string>>): {
  readonly token?: string;
} {
  return form.token === undefined || form.token === ""
    ? {}
    : { token: validateHomeAssistantToken(form.token) };
}

function outboundPayloadFromForm(form: Readonly<Record<string, string>>): {
  readonly payloadFormat: "standard" | "discord";
  readonly allowPrivateNetwork: boolean;
} {
  const payloadFormat =
    form.payloadFormat === undefined || form.payloadFormat === "standard"
      ? "standard"
      : form.payloadFormat === "discord"
        ? "discord"
        : invalidForm("Payload format is invalid.", "payloadFormat");
  return { payloadFormat, allowPrivateNetwork: form.allowPrivateNetwork === "on" };
}

/** The New destination form. */
export function outboundCreateFromForm(
  form: Readonly<Record<string, string>>,
): CreateOutboundDestinationInput {
  const transport =
    form.transport === "webhook"
      ? "webhook"
      : form.transport === "home_assistant"
        ? "home_assistant"
        : invalidForm("Choose an outbound transport.", "transport");
  const common = {
    label: form.label ?? "",
    transport,
    required: form.required === "on",
    enabled: form.enabled === "on",
    subscriptions: outboundSubscriptionsFromForm(form),
    staticHeaders: outboundStaticHeadersFromForm(form),
    secretHeaders: outboundSecretHeadersFromForm(form),
  } as const;
  if (transport === "home_assistant") {
    const baseUrl = (form.baseUrl ?? "").trim();
    if (baseUrl === "") invalidForm("Home Assistant base URL is required.", "baseUrl");
    return { ...common, baseUrl, ...outboundTokenFromForm(form) };
  }
  const webhookUrl = (form.webhookUrl ?? "").trim();
  if (webhookUrl === "") invalidForm("Webhook endpoint is required.", "webhookUrl");
  return { ...common, webhookUrl, ...outboundPayloadFromForm(form) };
}

/** A destination page's live Settings form. */
export function outboundSettingsFromForm(
  form: Readonly<Record<string, string>>,
  transport: OutboundTransport,
): OutboundSettingsInput {
  return {
    label: form.label ?? "",
    subscriptions: outboundSubscriptionsFromForm(form),
    ...(transport === "webhook" ? outboundPayloadFromForm(form) : {}),
  };
}

/** A destination page's Headers form, which always posts every row. */
export function outboundHeadersFromForm(
  form: Readonly<Record<string, string>>,
  destination: OutboundDestination,
): OutboundHeadersInput {
  return {
    staticHeaders: outboundStaticHeadersFromForm(
      form,
      destination.currentVersion?.config.staticHeaders,
    ),
    secretHeaders: outboundSecretHeadersFromForm(form),
  };
}

export function machineKeyPageData(
  dependencies: MachineKeyPageDataDependencies,
  context: AdminContext,
  title: string,
  sourceName: string,
  machineKey: string,
): Readonly<Record<string, unknown>> {
  const display = dependencies.displayService.getSettings();
  const breadcrumbs = adminBreadcrumbs(
    "/admin/integrations/telemetry",
    "/admin/integrations/telemetry",
    title,
    [TELEMETRY_CRUMB],
  );
  return {
    page: {
      title,
      path: "/admin/integrations/telemetry",
      breadcrumbs,
      csrfToken: context.csrfToken,
      siteName: display.tapboardName,
      themeColors: ADMIN_THEME_COLORS,
      displayStylesheetHref: displayStylesheetHref(display.theme, display.accent, display.font),
      returnPath: "/admin/integrations/telemetry",
    },
    nav: adminNav("/admin/integrations/telemetry", breadcrumbs),
    source: { name: sourceName },
    machineKey,
    endpointUrl: telemetryEndpointUrl(dependencies.canonicalOrigin),
  };
}
