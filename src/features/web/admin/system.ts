import { CURRENT_SCHEMA_VERSION } from "../../../infrastructure/database/migrations.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import { APPLICATION_VERSION } from "../../../shared/version.ts";
import type { SystemService } from "../../system/index.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  validationFieldsFor,
} from "./http.ts";
import { actor, type AdminContext } from "./context.ts";
import { renderAdmin } from "./layout.ts";
import { invalidForm } from "./forms.ts";
import type {
  RegisterSystemPagesDependencies,
  RegisterSystemMutationsDependencies,
  RequireSystemServiceDependencies,
} from "../contracts.ts";

export function registerSystemPages(dependencies: RegisterSystemPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/system", (request, response, context) => {
    const service = requireSystemService(dependencies);
    const diagnostics = service.getDiagnostics();
    const ready = dependencies.isReady?.() ?? true;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/system",
      "System",
      "/admin/system",
      {
        system: {
          version: APPLICATION_VERSION,
          ready,
          badge: ready
            ? { label: "Ready", tone: "healthy" }
            : { label: "Unavailable", tone: "degraded" },
          schemaVersion: CURRENT_SCHEMA_VERSION,
          liveClients: dependencies.liveUpdates.stats(),
          connectivity: dependencies.dashboardService.getHeader().connectivityLabel,
          diagnostics,
          calculation: service.getCalculationSettings(),
          display: dependencies.displayService.getSettings(),
          sessionPolicy: dependencies.authService.getSessionPolicy(),
        },
      },
    );
  });
}

export function registerSystemMutations(dependencies: RegisterSystemMutationsDependencies): void {
  const calculationFields = ["fallbackFg", "servingSizeMl"] as const;
  const saveCalculation = (form: Readonly<Record<string, string>>, context: AdminContext) => {
    systemFormFields(form, calculationFields);
    return requireSystemService(dependencies).updateCalculationSettings(
      {
        fallbackFg: systemFormNumber(form, "fallbackFg"),
        servingSizeMl: systemFormNumber(form, "servingSizeMl"),
      },
      { sessionId: context.session.id },
    );
  };
  registerAdminAction(
    dependencies,
    "/admin/system/calculation",
    "/admin/system",
    (form, context) => {
      saveCalculation(form, context);
    },
    "Calculation defaults saved.",
    {},
    {
      // These settings keep no revision, so the whole form saves as the form post does.
      handle: (body, context) => ({
        resource: { ...saveCalculation(autosaveFieldStrings(body, calculationFields), context) },
      }),
      current: () => ({ current: requireSystemService(dependencies).getCalculationSettings() }),
      validationFields: validationFieldsFor(calculationFields),
    },
  );
  const sessionPolicyFields = ["inactivityMinutes", "absoluteMinutes", "expectedRevision"] as const;
  const saveSessionPolicy = (form: Readonly<Record<string, string>>, context: AdminContext) => {
    systemFormFields(form, sessionPolicyFields);
    // The auth service checks these too, but reports one message for both fields; checking
    // here names the field that is wrong. The bounds match the inputs' min and max.
    const lifetime = (field: string) => {
      const milliseconds = systemDurationMinutes(form, field);
      if (milliseconds < 60_000 || milliseconds > 525_600 * 60_000) {
        invalidForm("Use one minute to one year (525,600 minutes).", field);
      }
      return milliseconds;
    };
    const inactivityMs = lifetime("inactivityMinutes");
    const absoluteMs = lifetime("absoluteMinutes");
    if (inactivityMs > absoluteMs) {
      invalidForm("Inactivity can't be longer than the absolute lifetime.", "inactivityMinutes");
    }
    return dependencies.authService.updateSessionPolicy(
      {
        inactivityMs,
        absoluteMs,
        expectedRevision: systemFormNumber(form, "expectedRevision"),
      },
      actor(context),
    );
  };
  /** The policy as the form shows it: minutes, and the revision a save must name. */
  const sessionPolicyView = (
    policy: ReturnType<typeof dependencies.authService.getSessionPolicy>,
  ) => ({
    resource: {
      inactivityMinutes: policy.inactivityMs / 60_000,
      absoluteMinutes: policy.absoluteMs / 60_000,
    },
    revision: policy.revision,
  });
  const sessionPolicySaved =
    "Session lifetimes saved. Shorter limits apply to existing sessions immediately.";
  registerAdminAction(
    dependencies,
    "/admin/system/session-policy",
    "/admin/system",
    (form, context) => {
      saveSessionPolicy(form, context);
    },
    sessionPolicySaved,
    {},
    {
      // The service checks expectedRevision, so a stale one answers 409.
      handle: (body, context) => ({
        ...sessionPolicyView(
          saveSessionPolicy(autosaveFieldStrings(body, sessionPolicyFields), context),
        ),
        message: sessionPolicySaved,
      }),
      current: () => {
        const view = sessionPolicyView(dependencies.authService.getSessionPolicy());
        return { current: view.resource, revision: view.revision };
      },
      validationFields: validationFieldsFor(sessionPolicyFields),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/system/pin",
    "/admin/system",
    async (form, context) => {
      systemFormFields(form, ["currentPin", "newPin", "confirmPin"]);
      if (form.newPin !== form.confirmPin) invalidForm("The new PINs must match.");
      if (!/^\d{4}$/u.test(form.newPin ?? "")) invalidForm("Use exactly four ASCII digits.");
      await dependencies.authService.changePin(form.currentPin, form.newPin, actor(context));
      return "/admin/login";
    },
    "PIN changed. Sign in again; all previous sessions were revoked.",
  );
}

export function requireSystemService(
  dependencies: RequireSystemServiceDependencies,
): SystemService {
  if (dependencies.systemService === undefined) {
    throw new ApplicationError({
      category: "unavailable",
      code: "system.unavailable",
      clientMessage: "System administration is unavailable.",
    });
  }
  return dependencies.systemService;
}

export function systemFormFields(
  form: Readonly<Record<string, string>>,
  fields: readonly string[],
): void {
  if (Object.keys(form).some((key) => key !== "_csrf" && !fields.includes(key))) {
    invalidForm("The form contains an unsupported field.");
  }
  if (fields.some((field) => form[field] === undefined || form[field] === "")) {
    invalidForm("Complete all fields before saving.");
  }
}

export function systemFormNumber(form: Readonly<Record<string, string>>, field: string): number {
  const value = form[field];
  if (value === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) {
    invalidForm("Enter a valid number.", field);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) invalidForm("Enter a valid number.", field);
  return parsed;
}

export function systemDurationMinutes(
  form: Readonly<Record<string, string>>,
  field: string,
): number {
  const milliseconds = systemFormNumber(form, field) * 60_000;
  const rounded = Math.round(milliseconds);
  // Displayed integer milliseconds can acquire a few floating-point bits
  // when converted to minutes and back. Preserve that valid round trip while
  // rejecting durations that genuinely specify fractional milliseconds.
  const tolerance = Math.max(1, Math.abs(milliseconds)) * Number.EPSILON * 4;
  if (!Number.isSafeInteger(rounded) || Math.abs(milliseconds - rounded) > tolerance) {
    invalidForm("Session lifetimes must resolve to whole milliseconds.", field);
  }
  return rounded;
}
