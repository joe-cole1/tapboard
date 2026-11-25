import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { TestContext } from "node:test";

import { createApplication } from "../../src/application.ts";
import { createAuthService } from "../../src/features/auth/service.ts";
import type { DatabaseConnection } from "../../src/infrastructure/database/connection.ts";
import type { Router } from "../../src/infrastructure/http/router.ts";
import { createLogger } from "../../src/shared/logging.ts";

const ORIGIN = "http://127.0.0.1:3000";

class CapturedResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    Object.assign(this.headers, headers);
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk);
  }
  destroy(): void {}
}

/** A real application on `database`, signed in, with GET and form-POST helpers. */
export async function adminApp(context: TestContext, database: DatabaseConnection) {
  const auth = createAuthService(database, { canonicalOrigin: ORIGIN });
  await auth.setPin("1234");
  const login = await auth.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  let router: Pick<Router, "handle"> | undefined;
  const application = createApplication({
    config: {
      host: "127.0.0.1",
      port: 0,
      databasePath: ":memory:",
      shutdownGraceMs: 100,
      canonicalExternalOrigin: ORIGIN,
    },
    logger: createLogger({ sink: () => undefined }),
    openDatabase: () => database,
    createHttpServer: (options) => {
      router = options.router;
      return {
        start: () => Promise.resolve({ address: "127.0.0.1", family: "IPv4", port: 0 }),
        stop: () => Promise.resolve(),
      };
    },
  });
  context.after(() => application.stop());
  await application.start();
  assert.ok(router);
  const route = router;
  async function send(path: string, values?: Record<string, string>) {
    const body =
      values === undefined
        ? ""
        : new URLSearchParams({ _csrf: login.csrfToken!, ...values }).toString();
    const input = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      method: values === undefined ? "GET" : "POST",
      url: path,
      headers: {
        cookie: `tapboard_admin_session=${login.session!}`,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const response = new CapturedResponse();
    await route.handle(input as IncomingMessage, response as unknown as ServerResponse);
    return response;
  }
  return {
    async get(path: string): Promise<string> {
      const response = await send(path);
      assert.equal(response.status, 200, path);
      return response.chunks.join("");
    },
    async post(path: string, values: Record<string, string>): Promise<string> {
      const response = await send(path, values);
      assert.equal(response.status, 303, path);
      return response.headers.location ?? "";
    },
    /** A live save, as admin-autosave.js sends it: JSON with the CSRF token in a header. */
    async autosave(
      path: string,
      values: Record<string, string>,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const input = Object.assign(Readable.from([Buffer.from(JSON.stringify(values))]), {
        method: "POST",
        url: path,
        headers: {
          cookie: `tapboard_admin_session=${login.session!}`,
          origin: ORIGIN,
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": login.csrfToken!,
          "x-tapboard-enhancement": "autosave",
        },
      });
      const response = new CapturedResponse();
      await route.handle(
        input as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      );
      return {
        status: response.status,
        body: JSON.parse(response.chunks.join("")) as Record<string, unknown>,
      };
    },
  };
}
