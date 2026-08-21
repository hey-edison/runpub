import { chmod, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { authConfigPath, authConfigPaths } from './config.js';

function processDirectory(project, env = process.env) {
  return path.join(path.dirname(authConfigPath(env)), 'processes', project);
}

function processDirectories(project, env = process.env) {
  return authConfigPaths(env).map((configPath) =>
    path.join(path.dirname(configPath), 'processes', project));
}

export async function saveProcessState(state, env = process.env) {
  const directory = processDirectory(state.project, env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const filePath = path.join(directory, `${state.pid}.json`);
  const temporaryPath = `${filePath}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

export async function removeProcessState(filePath) {
  if (!filePath) return;
  await unlink(filePath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export async function listProcessStates(project, env = process.env) {
  const states = [];
  const seen = new Set();
  for (const directory of processDirectories(project, env)) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const state = JSON.parse(await readFile(filePath, 'utf8'));
        if (
          state?.project === project &&
          Number.isInteger(state.pid) &&
          state.pid > 1 &&
          Array.isArray(state.services)
        ) {
          const key = `${state.project}:${state.pid}`;
          if (!seen.has(key)) states.push({ ...state, filePath });
          seen.add(key);
        } else {
          await removeProcessState(filePath);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') await removeProcessState(filePath);
      }
    }
  }
  return states;
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}
