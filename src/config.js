import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_NAME = 'runpublic.json';
export const LEGACY_PROJECT_CONFIG_NAME = 'devpublic.json';
const PROJECT_CONFIG_NAMES = [PROJECT_CONFIG_NAME, LEGACY_PROJECT_CONFIG_NAME];

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUPPORTED_PROTOCOLS = new Set(['http', 'https']);

function configHome(env = process.env) {
  if (env.RUNPUBLIC_HOME ?? env.DEVPUBLIC_HOME) {
    return path.resolve(env.RUNPUBLIC_HOME ?? env.DEVPUBLIC_HOME);
  }

  if (env.XDG_CONFIG_HOME) {
    return path.join(path.resolve(env.XDG_CONFIG_HOME), 'runpublic');
  }

  return path.join(os.homedir(), '.config', 'runpublic');
}

export function authConfigPath(env = process.env) {
  return path.join(configHome(env), 'config.json');
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function validateName(value, label) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a lowercase DNS-safe name (letters, numbers, and hyphens; maximum 63 characters)`,
    );
  }
  return value;
}

export function validateService(service, name) {
  assertObject(service, `services.${name}`);

  const unknownKeys = Object.keys(service).filter(
    (key) => !['command', 'port', 'cwd', 'env', 'host', 'protocol', 'readyTimeoutMs'].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`services.${name} has unknown field "${unknownKeys[0]}"`);
  }

  if (typeof service.command !== 'string' || service.command.trim() === '') {
    throw new Error(`services.${name}.command must be a non-empty string`);
  }

  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
    throw new Error(`services.${name}.port must be an integer between 1 and 65535`);
  }

  if (
    service.cwd !== undefined &&
    (typeof service.cwd !== 'string' ||
      service.cwd.trim() === '' ||
      path.isAbsolute(service.cwd) ||
      service.cwd.split(/[\\/]+/).includes('..'))
  ) {
    throw new Error(`services.${name}.cwd must be a relative path inside the project`);
  }

  if (service.env !== undefined) {
    assertObject(service.env, `services.${name}.env`);
    for (const [envName, envValue] of Object.entries(service.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        throw new Error(`services.${name}.env has invalid variable name "${envName}"`);
      }
      if (typeof envValue !== 'string') {
        throw new Error(`services.${name}.env.${envName} must be a string`);
      }
    }
  }

  if (
    service.host !== undefined &&
    (typeof service.host !== 'string' || service.host.trim() === '')
  ) {
    throw new Error(`services.${name}.host must be a non-empty string`);
  }

  if (service.protocol !== undefined && !SUPPORTED_PROTOCOLS.has(service.protocol)) {
    throw new Error(`services.${name}.protocol must be either "http" or "https"`);
  }

  if (
    service.readyTimeoutMs !== undefined &&
    (!Number.isInteger(service.readyTimeoutMs) ||
      service.readyTimeoutMs < 100 ||
      service.readyTimeoutMs > 120_000)
  ) {
    throw new Error(`services.${name}.readyTimeoutMs must be an integer between 100 and 120000`);
  }

  return {
    command: service.command,
    port: service.port,
    cwd: service.cwd ?? '.',
    env: service.env ?? {},
    host: service.host ?? '127.0.0.1',
    protocol: service.protocol ?? 'http',
    readyTimeoutMs: service.readyTimeoutMs ?? 15_000,
  };
}

export function validateProjectConfig(value, { requireServices = true } = {}) {
  assertObject(value, PROJECT_CONFIG_NAME);
  const unknownKeys = Object.keys(value).filter(
    (key) => !['$schema', 'project', 'services'].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${PROJECT_CONFIG_NAME} has unknown field "${unknownKeys[0]}"`);
  }
  const project = validateName(value.project, 'project');
  assertObject(value.services, 'services');

  const entries = Object.entries(value.services);
  if (requireServices && entries.length === 0) {
    throw new Error('services must define at least one service');
  }

  const services = {};
  for (const [name, service] of entries) {
    validateName(name, `service name "${name}"`);
    services[name] = validateService(service, name);
  }

  return { project, services };
}

export async function saveAuthConfig(auth, env = process.env) {
  const server = validateServer(auth.server);
  const account = validateName(auth.account, 'account');
  if (typeof auth.token !== 'string' || auth.token.trim() === '') {
    throw new Error('token must be a non-empty string');
  }

  const filePath = authConfigPath(env);
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(
      `${JSON.stringify({ server, account, token: auth.token }, null, 2)}\n`,
      'utf8',
    );
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  return filePath;
}

export function validateServer(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('server must be a non-empty URL');
  }

  const normalized = value.trim().replace(/\/$/, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('server must be a valid URL');
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('server URL must use http, https, ws, or wss');
  }
  if (url.username || url.password) {
    throw new Error('server URL must not contain credentials');
  }

  return normalized;
}

export async function loadAuthConfig(env = process.env) {
  let stored = {};
  const filePath = authConfigPath(env);

  try {
    const contents = await readFile(filePath, 'utf8');
    stored = JSON.parse(contents);
    assertObject(stored, filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new Error(`invalid JSON in ${filePath}`);
      }
      throw error;
    }
  }

  const auth = {
    server: env.RUNPUBLIC_SERVER ?? env.DEVPUBLIC_SERVER ?? stored.server,
    account: env.RUNPUBLIC_ACCOUNT ?? env.DEVPUBLIC_ACCOUNT ?? stored.account,
    token: env.RUNPUBLIC_TOKEN ?? env.DEVPUBLIC_TOKEN ?? stored.token,
  };

  const missing = Object.entries(auth)
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `not logged in: missing ${missing.join(', ')} (run "runpublic login" or set RUNPUBLIC_* environment variables)`,
    );
  }

  return {
    server: validateServer(auth.server),
    account: validateName(auth.account, 'account'),
    token: auth.token,
    source: filePath,
  };
}

export async function findProjectConfig(startDirectory = process.cwd()) {
  let directory = path.resolve(startDirectory);

  while (true) {
    for (const configName of PROJECT_CONFIG_NAMES) {
      const filePath = path.join(directory, configName);
      try {
        await access(filePath, constants.R_OK);
        return filePath;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          throw error;
        }
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`could not find ${PROJECT_CONFIG_NAME} from ${startDirectory}`);
    }
    directory = parent;
  }
}

export async function loadProjectConfig(startDirectory = process.cwd()) {
  const filePath = await findProjectConfig(startDirectory);
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON in ${filePath}`);
    }
    throw error;
  }

  return {
    path: filePath,
    directory: path.dirname(filePath),
    config: validateProjectConfig(value),
  };
}

export async function createProjectConfig(project, directory = process.cwd(), services = {}) {
  const validatedProject = validateName(project, 'project');
  const validated = validateProjectConfig(
    { project: validatedProject, services },
    { requireServices: false },
  );
  const filePath = path.join(path.resolve(directory), PROJECT_CONFIG_NAME);
  const handle = await open(filePath, 'wx', 0o644).catch((error) => {
    if (error?.code === 'EEXIST') {
      throw new Error(`${filePath} already exists`);
    }
    throw error;
  });

  try {
    await handle.writeFile(
      `${JSON.stringify({ project: validated.project, services }, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await handle.close();
  }

  return filePath;
}
