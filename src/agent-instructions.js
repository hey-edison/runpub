import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MANAGED_START = '<!-- runpublic:managed:start -->';
export const MANAGED_END = '<!-- runpublic:managed:end -->';

const RUNPUBLIC_INSTRUCTIONS = `${MANAGED_START}
## RunPublic remote development

- Use RunPublic when the user explicitly asks for a public URL, mobile or remote testing, a webhook endpoint, or on-the-go development access.
- From the project root, run \`runpublic status --json\` first and reuse an active URL when possible.
- Start one configured service with \`runpublic <service> --json\`. Use \`runpublic all --json\` when the requested test needs the complete frontend/backend stack.
- If \`runpublic.json\` is missing, inspect the repository and use non-interactive setup such as \`runpublic --services <folders> --json\`; do not guess when the correct services are unclear.
- Keep the RunPublic process alive for as long as remote access is needed, report every public URL to the user, and stop it only when asked.
- Treat every RunPublic URL as Internet-accessible. Never expose databases, admin/debug ports, secret dashboards, or services that rely on network privacy. Preserve the application's own authentication and authorization.
${MANAGED_END}`;

const CURSOR_FRONTMATTER = `---
description: Use RunPublic for explicitly requested public, mobile, remote, or webhook testing
alwaysApply: true
---`;

function homeDirectory(env) {
  return path.resolve(env.RUNPUBLIC_AGENT_HOME ?? env.HOME ?? os.homedir());
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function codexInstructionsPath(env, home) {
  const codexHome = path.resolve(env.CODEX_HOME ?? path.join(home, '.codex'));
  const overridePath = path.join(codexHome, 'AGENTS.override.md');
  return await exists(overridePath) ? overridePath : path.join(codexHome, 'AGENTS.md');
}

export async function agentInstructionTargets({
  projectDirectory = process.cwd(),
  env = process.env,
} = {}) {
  const home = homeDirectory(env);
  return [
    {
      id: 'codex',
      agent: 'Codex/ChatGPT coding agent',
      scope: 'global',
      path: await codexInstructionsPath(env, home),
    },
    {
      id: 'claude',
      agent: 'Claude Code',
      scope: 'global',
      path: path.join(home, '.claude', 'CLAUDE.md'),
    },
    {
      id: 'antigravity',
      agent: 'Antigravity',
      scope: 'global',
      path: path.join(home, '.gemini', 'GEMINI.md'),
    },
    {
      id: 'cursor',
      agent: 'Cursor',
      scope: 'project',
      path: path.join(path.resolve(projectDirectory), '.cursor', 'rules', 'runpublic.mdc'),
      frontmatter: CURSOR_FRONTMATTER,
    },
  ];
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function managedRange(contents, filePath) {
  const start = contents.indexOf(MANAGED_START);
  const end = contents.indexOf(MANAGED_END);
  if (start === -1 && end === -1) return undefined;
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`invalid RunPublic managed block in ${filePath}`);
  }
  const duplicateStart = contents.indexOf(MANAGED_START, start + MANAGED_START.length);
  const duplicateEnd = contents.indexOf(MANAGED_END, end + MANAGED_END.length);
  if (duplicateStart !== -1 || duplicateEnd !== -1) {
    throw new Error(`multiple RunPublic managed blocks found in ${filePath}`);
  }
  return { start, end: end + MANAGED_END.length };
}

function appendManagedBlock(contents, block) {
  if (!contents) return `${block}\n`;
  let prefix = contents;
  if (!prefix.endsWith('\n')) prefix += '\n';
  return `${prefix}${block}\n`;
}

function installContents(contents, target) {
  const range = managedRange(contents ?? '', target.path);
  if (range) {
    return `${contents.slice(0, range.start)}${RUNPUBLIC_INSTRUCTIONS}${contents.slice(range.end)}`;
  }
  const initial = contents ?? (target.frontmatter ? `${target.frontmatter}\n` : '');
  return appendManagedBlock(initial, RUNPUBLIC_INSTRUCTIONS);
}

async function atomicWrite(filePath, contents, existing) {
  let writablePath = filePath;
  try {
    if ((await lstat(filePath)).isSymbolicLink()) writablePath = await realpath(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const directory = path.dirname(writablePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(writablePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const existingMode = existing === undefined ? 0o644 : (await stat(writablePath)).mode & 0o777;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', existingMode);
    await handle.writeFile(contents, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, writablePath);
    await chmod(writablePath, existingMode);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function installAgentInstructions(options = {}) {
  const targets = await agentInstructionTargets(options);
  const prepared = await Promise.all(targets.map(async (target) => {
    const existing = await readOptional(target.path);
    const contents = installContents(existing, target);
    return { target, existing, contents };
  }));
  const results = [];
  for (const { target, existing, contents } of prepared) {
    if (contents !== existing) await atomicWrite(target.path, contents, existing);
    results.push({
      ...target,
      installed: true,
      action: existing === undefined ? 'created' : contents === existing ? 'unchanged' : 'updated',
    });
  }
  return results;
}

export async function agentInstructionStatus(options = {}) {
  const targets = await agentInstructionTargets(options);
  return await Promise.all(targets.map(async (target) => {
    const contents = await readOptional(target.path);
    let installed = false;
    if (contents !== undefined) installed = Boolean(managedRange(contents, target.path));
    return { ...target, installed };
  }));
}

export async function removeAgentInstructions(options = {}) {
  const targets = await agentInstructionTargets(options);
  const results = [];
  for (const target of targets) {
    const existing = await readOptional(target.path);
    if (existing === undefined) {
      results.push({ ...target, installed: false, action: 'missing' });
      continue;
    }
    const range = managedRange(existing, target.path);
    if (!range) {
      results.push({ ...target, installed: false, action: 'unchanged' });
      continue;
    }
    let end = range.end;
    if (existing[end] === '\n') end += 1;
    const contents = `${existing.slice(0, range.start)}${existing.slice(end)}`;
    const cursorRuleIsEmpty = target.id === 'cursor' &&
      contents.trim() === target.frontmatter.trim();
    if (cursorRuleIsEmpty) {
      await unlink(target.path);
    } else {
      await atomicWrite(target.path, contents, existing);
    }
    results.push({ ...target, installed: false, action: 'removed' });
  }
  return results;
}
