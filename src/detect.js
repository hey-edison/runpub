import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { sanitizeDnsLabel } from './naming.js';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);

const FRONTEND_PACKAGES = [
  '@angular/core',
  '@sveltejs/kit',
  'astro',
  'gatsby',
  'next',
  'nuxt',
  'react',
  'react-dom',
  'svelte',
  'vite',
  'vue',
];
const BACKEND_PACKAGES = [
  '@nestjs/core',
  'express',
  'fastify',
  'hapi',
  'koa',
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${filePath}`);
    throw error;
  }
}

function allDependencies(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };
}

function packageRole(packageJson, directoryName) {
  const dependencies = allDependencies(packageJson);
  const normalizedName = `${packageJson.name ?? ''} ${directoryName}`.toLowerCase();
  const hasFrontend = FRONTEND_PACKAGES.some((name) => dependencies[name] !== undefined);
  const hasBackend = BACKEND_PACKAGES.some((name) => dependencies[name] !== undefined);

  if (hasFrontend && !hasBackend) return 'frontend';
  if (hasBackend && !hasFrontend) return 'backend';
  if (/\b(frontend|client|web|ui)\b/.test(normalizedName)) return 'frontend';
  if (/\b(backend|server|api|service)\b/.test(normalizedName)) return 'backend';
  if (hasFrontend) return 'frontend';
  if (hasBackend) return 'backend';
  return 'app';
}

function inferNodePort(script, packageJson, role) {
  const explicit = String(script).match(
    /(?:^|\s)(?:PORT\s*=\s*|--port(?:=|\s+)|-p\s+)(\d{2,5})(?:\s|$)/,
  );
  if (explicit) return Number(explicit[1]);

  const dependencies = allDependencies(packageJson);
  if (dependencies.vite || dependencies.astro) return 5173;
  if (dependencies['@angular/core']) return 4200;
  if (dependencies.gatsby) return 8000;
  if (role === 'backend') return 8000;
  return 3000;
}

function nodePortArgument(packageJson) {
  const dependencies = allDependencies(packageJson);
  if (dependencies.next) return '-- -p';
  if (
    dependencies.vite ||
    dependencies.astro ||
    dependencies.nuxt ||
    dependencies.gatsby ||
    dependencies['@angular/core']
  ) {
    return '-- --port';
  }
  return undefined;
}

async function packageManager(directory, rootDirectory) {
  const checks = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const base of [directory, rootDirectory]) {
    for (const [lockfile, manager] of checks) {
      if (await exists(path.join(base, lockfile))) return manager;
    }
  }
  return 'npm';
}

function scriptCommand(manager, scriptName) {
  return `${manager} run ${scriptName}`;
}

async function detectNodeServices(directory, rootDirectory) {
  const packageJson = await readJson(path.join(directory, 'package.json'));
  if (!packageJson) return [];
  const scripts = packageJson.scripts ?? {};
  const manager = await packageManager(directory, rootDirectory);
  const relativeDirectory = path.relative(rootDirectory, directory) || '.';
  const directoryName = path.basename(directory);
  const services = [];

  const explicitScripts = [
    ['frontend', scripts['dev:frontend'] ? 'dev:frontend' : scripts.frontend ? 'frontend' : undefined],
    ['backend', scripts['dev:backend'] ? 'dev:backend' : scripts.backend ? 'backend' : undefined],
  ];
  for (const [role, scriptName] of explicitScripts) {
    if (!scriptName) continue;
    services.push({
      suggestedName: role,
      command: scriptCommand(manager, scriptName),
      port: inferNodePort(scripts[scriptName], packageJson, role),
      cwd: relativeDirectory,
      detectedAs: `Node.js ${role}`,
      portArgument: nodePortArgument(packageJson),
    });
  }
  if (services.length > 0) return services;

  const scriptName = ['dev', 'start:dev', 'serve', 'start'].find(
    (candidate) => typeof scripts[candidate] === 'string' && scripts[candidate].trim() !== '',
  );
  if (!scriptName) return [];
  const role = packageRole(packageJson, directoryName);
  return [
    {
      suggestedName: role,
      command: scriptCommand(manager, scriptName),
      port: inferNodePort(scripts[scriptName], packageJson, role),
      cwd: relativeDirectory,
      detectedAs: `Node.js ${role}`,
      portArgument: nodePortArgument(packageJson),
    },
  ];
}

async function pythonLauncher(directory) {
  if (await exists(path.join(directory, '.venv', 'bin', 'python'))) {
    return '.venv/bin/python';
  }
  if (await exists(path.join(directory, '.venv', 'Scripts', 'python.exe'))) {
    return '.venv/Scripts/python.exe';
  }
  if (await exists(path.join(directory, 'venv', 'bin', 'python'))) {
    return 'venv/bin/python';
  }
  if (await exists(path.join(directory, 'venv', 'Scripts', 'python.exe'))) {
    return 'venv/Scripts/python.exe';
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function detectPythonServices(directory, rootDirectory) {
  const markers = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'manage.py'];
  const present = await Promise.all(markers.map((marker) => exists(path.join(directory, marker))));
  if (!present.some(Boolean)) return [];

  let dependencyText = '';
  for (const fileName of ['pyproject.toml', 'requirements.txt', 'Pipfile']) {
    try {
      dependencyText += `\n${await readFile(path.join(directory, fileName), 'utf8')}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const python = await pythonLauncher(directory);
  const cwd = path.relative(rootDirectory, directory) || '.';
  if (present[3] || /\bdjango\b/i.test(dependencyText)) {
    return [{
      suggestedName: 'backend',
      command: `${python} manage.py runserver 0.0.0.0:8000`,
      port: 8000,
      cwd,
      detectedAs: 'Django backend',
    }];
  }
  if (/\bfastapi\b/i.test(dependencyText) || await exists(path.join(directory, 'app', 'main.py'))) {
    const moduleName = await exists(path.join(directory, 'app', 'main.py')) ? 'app.main:app' : 'main:app';
    return [{
      suggestedName: 'backend',
      command: `${python} -m uvicorn ${moduleName} --reload --port 8000`,
      port: 8000,
      cwd,
      detectedAs: 'FastAPI backend',
    }];
  }
  if (/\bflask\b/i.test(dependencyText)) {
    return [{
      suggestedName: 'backend',
      command: `${python} -m flask --app app run --debug --port 5000`,
      port: 5000,
      cwd,
      detectedAs: 'Flask backend',
    }];
  }
  return [];
}

async function workspaceDirectories(rootDirectory, packageJson) {
  const raw = Array.isArray(packageJson?.workspaces)
    ? packageJson.workspaces
    : packageJson?.workspaces?.packages;
  if (!Array.isArray(raw)) return [];

  const directories = [];
  for (const pattern of raw) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
    if (pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*')) {
      const parent = path.join(rootDirectory, pattern.slice(0, -2));
      try {
        const entries = await readdir(parent, { withFileTypes: true });
        directories.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name)));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } else if (!pattern.includes('*')) {
      directories.push(path.join(rootDirectory, pattern));
    }
  }
  return directories;
}

async function conventionalDirectories(rootDirectory) {
  const exact = ['frontend', 'backend', 'client', 'server', 'web', 'api'];
  const directories = [];
  for (const name of exact) {
    const candidate = path.join(rootDirectory, name);
    if (await exists(candidate)) directories.push(candidate);
  }
  for (const parentName of ['apps', 'packages', 'services']) {
    const parent = path.join(rootDirectory, parentName);
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      directories.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return directories;
}

function uniqueServiceName(suggestedName, cwd, services, repeatedRole = false) {
  const base = sanitizeDnsLabel(suggestedName, 'app');
  const directoryName = sanitizeDnsLabel(path.basename(cwd), base);
  const qualified = directoryName.includes(base) ? directoryName : `${directoryName}-${base}`;
  if (repeatedRole && !Object.hasOwn(services, qualified)) return qualified;
  if (!Object.hasOwn(services, base)) return base;
  if (!Object.hasOwn(services, qualified)) return qualified;
  let suffix = 2;
  while (Object.hasOwn(services, `${qualified}-${suffix}`)) suffix += 1;
  return `${qualified}-${suffix}`;
}

export async function inferProjectName(directory = process.cwd()) {
  const packageJson = await readJson(path.join(directory, 'package.json'));
  const packageName = packageJson?.name?.split('/').at(-1);
  return sanitizeDnsLabel(packageName || path.basename(path.resolve(directory)), 'project').slice(0, 63).replace(/-+$/g, '');
}

export async function detectProject(directory = process.cwd(), projectOverride) {
  const rootDirectory = path.resolve(directory);
  const rootPackage = await readJson(path.join(rootDirectory, 'package.json'));
  const workspaceDirs = await workspaceDirectories(rootDirectory, rootPackage);
  const candidateDirectories = workspaceDirs.length > 0
    ? workspaceDirs
    : await conventionalDirectories(rootDirectory);
  const hasChildCandidates = candidateDirectories.length > 0;
  if (!hasChildCandidates || !rootPackage?.workspaces) candidateDirectories.unshift(rootDirectory);

  const seen = new Set();
  const detected = [];
  for (const candidate of candidateDirectories) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized) || IGNORED_DIRECTORIES.has(path.basename(normalized))) continue;
    seen.add(normalized);
    const nodeServices = await detectNodeServices(normalized, rootDirectory);
    if (nodeServices.length > 0) detected.push(...nodeServices);
    else detected.push(...await detectPythonServices(normalized, rootDirectory));
  }

  const services = {};
  const detections = [];
  const roleCounts = new Map();
  for (const candidate of detected) {
    roleCounts.set(candidate.suggestedName, (roleCounts.get(candidate.suggestedName) ?? 0) + 1);
  }
  const usedPorts = new Set();
  for (const candidate of detected) {
    const name = uniqueServiceName(
      candidate.suggestedName,
      candidate.cwd,
      services,
      roleCounts.get(candidate.suggestedName) > 1,
    );
    let port = candidate.port;
    let command = candidate.command;
    if (usedPorts.has(port) && candidate.portArgument) {
      while (usedPorts.has(port)) port += 1;
      command = `${command} ${candidate.portArgument} ${port}`;
    }
    usedPorts.add(port);
    services[name] = {
      command,
      port,
      ...(candidate.cwd === '.' ? {} : { cwd: candidate.cwd }),
    };
    detections.push({ name, ...candidate, command, port });
  }

  return {
    project: sanitizeDnsLabel(projectOverride || await inferProjectName(rootDirectory), 'project').slice(0, 63).replace(/-+$/g, ''),
    services,
    detections,
  };
}
