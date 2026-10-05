import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";

export function registerLocalDashboard(
  app: FastifyInstance,
  config: AppConfig,
) {
  const sessions = new Map<string, number>();
  const expectedHost = `127.0.0.1:${config.PORT}`;
  const expectedOrigin = `http://${expectedHost}`;
  const cookieName = `gordion_local_${config.PORT}`;
  const local = (request: FastifyRequest) =>
    config.LOCAL_DASHBOARD_ENABLED &&
    request.ip === "127.0.0.1" &&
    request.headers.host === expectedHost;
  const sameOrigin = (request: FastifyRequest) =>
    request.headers.origin === expectedOrigin;

  if (config.LOCAL_DASHBOARD_ENABLED) {
    app.get("/gordion-logo.png", async (request, reply) => {
      if (!local(request)) return reply.code(403).send({ error: "local_only" });
      return reply
        .header("cache-control", "no-store")
        .type("image/png")
        .send(await readFile(path.resolve("assets/gordion-logo.png")));
    });
    const files = [
      ["/", "index.html", "text/html"],
      ["/console.js", "console.js", "application/javascript"],
      ["/console.css", "console.css", "text/css"],
    ] as const;
    for (const [url, file, contentType] of files) {
      app.get(url, async (request, reply) => {
        if (!local(request))
          return reply.code(403).send({ error: "local_only" });
        return reply
          .header("cache-control", "no-store")
          .header(
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          )
          .type(contentType)
          .send(await readFile(path.resolve("ui", file), "utf8"));
      });
    }
    app.post("/local/session", async (request, reply) => {
      if (!local(request) || !sameOrigin(request))
        return reply.code(403).send({ error: "local_origin_required" });
      if (config.MAIL_PROVIDER !== 'simulated' || config.LIVE_SEND_ENABLED)
        return reply.code(401).send({ error: 'operator_login_required' });
      for (const [token, expires] of sessions)
        if (expires <= Date.now()) sessions.delete(token);
      if (sessions.size >= 100)
        return reply.code(429).send({ error: "too_many_sessions" });
      const token = randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + 8 * 60 * 60_000);
      return reply
        .header("cache-control", "no-store")
        .header(
          "set-cookie",
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        )
        .send({ authenticated: true, mode: "local_simulator" });
    });
  }

  return (request: FastifyRequest): boolean => {
    if (!local(request)) return false;
    if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request))
      return false;
    const token = request.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!token || (sessions.get(token) ?? 0) <= Date.now()) return false;
    return true;
  };
}

export function keyMatches(supplied: unknown, expected: string | undefined) {
  if (typeof supplied !== "string" || !expected) return false;
  const a = Buffer.from(supplied),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
