import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProjectConfig,
  loadAuthConfig,
  loadProjectConfig,
  saveAuthConfig,
  validateProjectConfig
} from "../src/config.js";

test("stores authentication outside the project with private permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devpublic-auth-"));
  const env = { DEVPUBLIC_HOME: directory };

  const filePath = await saveAuthConfig(
    {
      server: "https://edge.example.com/",
      account: "keshavmac",
      token: "a-secret-that-must-not-be-printed"
    },
    env
  );

  const auth = await loadAuthConfig(env);
  assert.deepEqual(
    { server: auth.server, account: auth.account, token: auth.token },
    {
      server: "https://edge.example.com",
      account: "keshavmac",
      token: "a-secret-that-must-not-be-printed"
    }
  );
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("environment variables override stored authentication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devpublic-auth-"));
  await saveAuthConfig(
    { server: "https://old.example.com", account: "old-user", token: "old-token" },
    { DEVPUBLIC_HOME: directory }
  );

  const auth = await loadAuthConfig({
    DEVPUBLIC_HOME: directory,
    DEVPUBLIC_SERVER: "https://new.example.com",
    DEVPUBLIC_ACCOUNT: "new-user",
    DEVPUBLIC_TOKEN: "new-token"
  });
  assert.equal(auth.server, "https://new.example.com");
  assert.equal(auth.account, "new-user");
  assert.equal(auth.token, "new-token");
});

test("loads legacy RunPublic credentials and environment overrides", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "runpub-legacy-auth-"));
  const legacyHome = path.join(base, "runpublic");
  await saveAuthConfig(
    { server: "https://old.example.com", account: "old-user", token: "old-token" },
    { RUNPUBLIC_HOME: legacyHome }
  );

  const auth = await loadAuthConfig({
    XDG_CONFIG_HOME: base,
    RUNPUBLIC_SERVER: "https://legacy.example.com",
    RUNPUBLIC_ACCOUNT: "legacy-user",
    RUNPUBLIC_TOKEN: "legacy-token"
  });
  assert.equal(auth.server, "https://legacy.example.com");
  assert.equal(auth.account, "legacy-user");
  assert.equal(auth.token, "legacy-token");
  assert.equal(auth.source, path.join(legacyHome, "config.json"));
});

test("finds and validates project configuration from a nested directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devpublic-project-"));
  await createProjectConfig("fullstack-demo", directory);
  const configPath = path.join(directory, "runpub.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.services.frontend = {
    command: "npm run dev",
    port: 5173
  };
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  );
  const nested = path.join(directory, "packages", "frontend");
  await mkdir(nested, { recursive: true });

  const loaded = await loadProjectConfig(nested);
  assert.equal(loaded.path, configPath);
  assert.deepEqual(loaded.config.services.frontend, {
    command: "npm run dev",
    port: 5173,
    cwd: ".",
    env: {},
    host: "127.0.0.1",
    protocol: "http",
    readyTimeoutMs: 15000
  });
});

test("loads a legacy runpublic.json manifest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runpub-legacy-project-"));
  const configPath = path.join(directory, "runpublic.json");
  await writeFile(configPath, `${JSON.stringify({
    project: "legacy-demo",
    services: { frontend: { command: "npm run dev", port: 5173 } }
  })}\n`);
  const loaded = await loadProjectConfig(directory);
  assert.equal(loaded.path, configPath);
  assert.equal(loaded.config.project, "legacy-demo");
});

test("accepts a safe monorepo service working directory", () => {
  const config = validateProjectConfig({
    project: "fullstack-demo",
    services: {
      frontend: { command: "npm run dev", port: 3000, cwd: "apps/web" }
    }
  });
  assert.equal(config.services.frontend.cwd, "apps/web");
  assert.deepEqual(config.services.frontend.env, {});
  assert.throws(
    () => validateProjectConfig({
      project: "fullstack-demo",
      services: {
        frontend: { command: "npm run dev", port: 3000, cwd: "../other-project" }
      }
    }),
    /relative path inside the project/
  );
});

test("accepts string environment mappings and rejects unsafe entries", () => {
  const config = validateProjectConfig({
    project: "fullstack-demo",
    services: {
      frontend: {
        command: "npm run dev",
        port: 3000,
        env: { NEXT_PUBLIC_API_BASE: "${RUNPUB_BACKEND_URL}/api/v1" }
      }
    }
  });
  assert.equal(
    config.services.frontend.env.NEXT_PUBLIC_API_BASE,
    "${RUNPUB_BACKEND_URL}/api/v1"
  );
  assert.throws(
    () => validateProjectConfig({
      project: "fullstack-demo",
      services: {
        frontend: { command: "npm run dev", port: 3000, env: { "BAD-NAME": "x" } }
      }
    }),
    /invalid variable name/
  );
});

test("rejects unsafe project configuration", () => {
  assert.throws(
    () =>
      validateProjectConfig({
        project: "Not DNS Safe",
        services: { frontend: { command: "npm run dev", port: 5173 } }
      }),
    /DNS-safe/
  );
  assert.throws(
    () =>
      validateProjectConfig({
        project: "safe",
        services: { database: { command: "postgres", port: 70000 } }
      }),
    /65535/
  );
});

test("explicit overwrite atomically replaces an existing project configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runpub-overwrite-"));
  await createProjectConfig("first-project", directory, {
    frontend: { command: "npm run dev", port: 3000 }
  });
  await createProjectConfig("second-project", directory, {
    backend: { command: "python3 -m uvicorn app:app", port: 8000 }
  }, { overwrite: true });

  const saved = JSON.parse(await readFile(path.join(directory, "runpub.json"), "utf8"));
  assert.equal(saved.project, "second-project");
  assert.deepEqual(Object.keys(saved.services), ["backend"]);
});
