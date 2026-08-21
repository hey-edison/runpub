import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MANAGED_START,
  agentInstructionStatus,
  installAgentInstructions,
  removeAgentInstructions,
} from '../src/agent-instructions.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-agents-'));
  const home = path.join(directory, 'home');
  const projectDirectory = path.join(directory, 'project');
  await mkdir(projectDirectory, { recursive: true });
  return {
    home,
    projectDirectory,
    env: { HOME: home },
  };
}

test('installs supported global instructions and a project Cursor rule', async () => {
  const options = await fixture();
  await mkdir(path.join(options.home, '.codex'), { recursive: true });
  const agentsPath = path.join(options.home, '.codex', 'AGENTS.md');
  await writeFile(agentsPath, '# My existing instructions\n');

  const installed = await installAgentInstructions(options);
  assert.deepEqual(installed.map((target) => target.id), [
    'codex',
    'claude',
    'antigravity',
    'cursor',
  ]);

  const agents = await readFile(agentsPath, 'utf8');
  assert.match(agents, /^# My existing instructions/m);
  assert.match(agents, new RegExp(MANAGED_START));
  assert.match(agents, /runpublic status --json/);
  assert.match(agents, /Internet-accessible/);

  const cursor = await readFile(
    path.join(options.projectDirectory, '.cursor', 'rules', 'runpublic.mdc'),
    'utf8',
  );
  assert.match(cursor, /^---\ndescription:/);
  assert.match(cursor, /alwaysApply: true/);

  const status = await agentInstructionStatus(options);
  assert.ok(status.every((target) => target.installed));
});

test('installation is idempotent and updates only its managed block', async () => {
  const options = await fixture();
  await installAgentInstructions(options);
  const agentsPath = path.join(options.home, '.codex', 'AGENTS.md');
  const before = await readFile(agentsPath, 'utf8');
  const installed = await installAgentInstructions(options);
  const after = await readFile(agentsPath, 'utf8');

  assert.equal(after, before);
  assert.equal(after.split(MANAGED_START).length - 1, 1);
  assert.ok(installed.every((target) => target.action === 'unchanged'));
});

test('uses AGENTS.override.md when Codex global override already exists', async () => {
  const options = await fixture();
  const codexDirectory = path.join(options.home, '.codex');
  await mkdir(codexDirectory, { recursive: true });
  const overridePath = path.join(codexDirectory, 'AGENTS.override.md');
  await writeFile(overridePath, '# Override\n');

  const results = await installAgentInstructions(options);
  assert.equal(results.find((target) => target.id === 'codex').path, overridePath);
  assert.match(await readFile(overridePath, 'utf8'), /RunPublic remote development/);
});

test('preserves instruction-file symlinks', async () => {
  const options = await fixture();
  const codexDirectory = path.join(options.home, '.codex');
  const claudeDirectory = path.join(options.home, '.claude');
  await mkdir(codexDirectory, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  const agentsPath = path.join(codexDirectory, 'AGENTS.md');
  const claudePath = path.join(claudeDirectory, 'CLAUDE.md');
  await writeFile(agentsPath, '# Shared agent instructions\n');
  await symlink(path.join('..', '.codex', 'AGENTS.md'), claudePath);

  await installAgentInstructions(options);
  assert.ok((await lstat(claudePath)).isSymbolicLink());
  assert.equal(
    (await readFile(agentsPath, 'utf8')).split(MANAGED_START).length - 1,
    1,
  );
});

test('removes managed instructions without removing existing instructions', async () => {
  const options = await fixture();
  const claudeDirectory = path.join(options.home, '.claude');
  await mkdir(claudeDirectory, { recursive: true });
  const claudePath = path.join(claudeDirectory, 'CLAUDE.md');
  await writeFile(claudePath, '# Personal Claude instructions\n');
  await installAgentInstructions(options);

  const removed = await removeAgentInstructions(options);
  assert.ok(removed.every((target) => target.action === 'removed'));
  assert.equal(await readFile(claudePath, 'utf8'), '# Personal Claude instructions\n');
  const status = await agentInstructionStatus(options);
  assert.ok(status.every((target) => !target.installed));
});

test('rejects malformed managed markers instead of overwriting the file', async () => {
  const options = await fixture();
  const claudeDirectory = path.join(options.home, '.claude');
  await mkdir(claudeDirectory, { recursive: true });
  const claudePath = path.join(claudeDirectory, 'CLAUDE.md');
  await writeFile(claudePath, `# Keep me\n${MANAGED_START}\n`);

  await assert.rejects(
    installAgentInstructions(options),
    /invalid RunPublic managed block/,
  );
  assert.equal(await readFile(claudePath, 'utf8'), `# Keep me\n${MANAGED_START}\n`);
  await assert.rejects(
    readFile(path.join(options.home, '.codex', 'AGENTS.md'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
});
