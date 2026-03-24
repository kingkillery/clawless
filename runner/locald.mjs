#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOST = process.env.CLAWLESS_LOCALD_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CLAWLESS_LOCALD_PORT ?? '6234');
const HOME_DIR = '/home/clawless';
const ROOT = resolve(tmpdir(), 'clawless-locald');

/** @type {Map<string, Session>} */
const sessions = new Map();

await mkdir(ROOT, { recursive: true });

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      await handleHealth(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      await handleCreateSession(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      await sendJson(res, [...sessions.values()].map((session) => sessionSummary(session)));
      return;
    }
    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(.*)$/);
    if (!sessionMatch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const session = sessions.get(sessionMatch[1]);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown_session' }));
      return;
    }

    const suffix = sessionMatch[2] || '';
    if (req.method === 'GET' && suffix === '') {
      await sendJson(res, sessionSummary(session));
      return;
    }
    if (req.method === 'DELETE' && suffix === '') {
      await destroySession(session);
      await sendJson(res, { ok: true });
      return;
    }
    if (req.method === 'GET' && suffix === '/events') {
      await handleEvents(session, res);
      return;
    }
    if (req.method === 'POST' && suffix === '/exec') {
      await handleExec(session, req, res);
      return;
    }
    if (req.method === 'POST' && suffix === '/process') {
      await handleProcessStart(session, req, res);
      return;
    }
    const processMatch = suffix.match(/^\/process\/([^/]+)\/input$/);
    if (req.method === 'POST' && processMatch) {
      await handleProcessInput(session, processMatch[1], req, res);
      return;
    }
    const processKillMatch = suffix.match(/^\/process\/([^/]+)$/);
    if (req.method === 'DELETE' && processKillMatch) {
      await handleProcessKill(session, processKillMatch[1], res);
      return;
    }
    if (req.method === 'GET' && suffix === '/files') {
      await handleListFiles(session, url, res);
      return;
    }
    if (suffix.startsWith('/files/')) {
      await handleFilePath(session, req, res, suffix.slice('/files/'.length));
      return;
    }
    if (req.method === 'POST' && suffix === '/mkdir') {
      await handleMkdir(session, req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown_route' }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[clawless-locald] listening on http://${HOST}:${PORT}`);
});

/** @typedef {{ id: string, status: string, image?: string, rootDir: string, containerId: string | null, processes: Map<string, SessionProcess>, nextProcessId: number, listeners: Set<import('node:http').ServerResponse>, watcher: ReturnType<typeof watch> | null, pollTimer: ReturnType<typeof setInterval> | null, snapshot: Map<string, string> }} Session */
/** @typedef {{ id: string, kind: 'exec'|'process', command: string, child: ReturnType<typeof spawn>, request: { command: string, args: string[], cwd: string, env: Record<string, string> }, persistent: boolean }} SessionProcess */

async function handleHealth(res) {
  const available = await canRunPodman();
  await sendJson(res, { ok: true, podman: available });
}

async function handleCreateSession(req, res) {
  const body = await readJson(req);
  const id = randomUUID();
  const rootDir = join(ROOT, id);
  const workspaceDir = join(rootDir, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const session = {
    id,
    status: 'booting',
    image: body?.image ?? 'node:20-bookworm-slim',
    rootDir,
    containerId: null,
    processes: new Map(),
    nextProcessId: 1,
    listeners: new Set(),
    watcher: null,
    pollTimer: null,
    snapshot: new Map(),
  };
  sessions.set(id, session);

  await writeWorkspaceFiles(session, body?.workspace ?? {});
  session.snapshot = await snapshot(workspaceDir, workspaceDir);
  await startContainer(session);
  startWatcher(session);
  session.status = 'ready';
  broadcast(session, 'session.status', { status: session.status });

  await sendJson(res, sessionSummary(session));
}

async function handleEvents(session, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`retry: 2000\n\n`);
  session.listeners.add(res);
  sendEvent(session, res, 'session.status', { status: session.status });
  const cleanup = () => session.listeners.delete(res);
  res.on('close', cleanup);
  res.on('finish', cleanup);
}

async function handleExec(session, req, res) {
  const body = await readJson(req);
  const result = await runCommand(session, {
    command: body?.command ?? 'sh',
    args: Array.isArray(body?.args) ? body.args : [],
    cwd: body?.cwd ?? HOME_DIR,
    env: body?.env ?? {},
  }, { streamToResponse: true, response: res });
  if (!res.writableEnded) {
    res.write(`__EXIT__:${result.exitCode}\n`);
    res.end();
  }
}

async function handleProcessStart(session, req, res) {
  const body = await readJson(req);
  const procId = String(session.nextProcessId++);
  const child = await runCommand(session, {
    command: body?.command ?? 'sh',
    args: Array.isArray(body?.args) ? body.args : [],
    cwd: body?.cwd ?? HOME_DIR,
    env: body?.env ?? {},
  }, { persistent: true, processId: procId });
  session.processes.set(procId, {
    id: procId,
    kind: 'process',
    command: `${body?.command ?? 'sh'} ${(body?.args ?? []).join(' ')}`.trim(),
    child,
    request: {
      command: body?.command ?? 'sh',
      args: Array.isArray(body?.args) ? body.args : [],
      cwd: body?.cwd ?? HOME_DIR,
      env: body?.env ?? {},
    },
    persistent: true,
  });
  await sendJson(res, { id: procId });
}

async function handleProcessInput(session, procId, req, res) {
  const process = session.processes.get(procId);
  if (!process) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown_process' }));
    return;
  }
  const body = await readJson(req);
  if (process.child.stdin.writable) {
    process.child.stdin.write(String(body?.data ?? ''));
  }
  await sendJson(res, { ok: true });
}

async function handleProcessKill(session, procId, res) {
  const process = session.processes.get(procId);
  if (!process) {
    await sendJson(res, { ok: true });
    return;
  }
  process.child.kill('SIGTERM');
  session.processes.delete(procId);
  await sendJson(res, { ok: true });
}

async function handleListFiles(session, url, res) {
  const dir = url.searchParams.get('dir') || 'workspace';
  const abs = resolvePath(session, dir);
  const files = await listWorkspace(abs, abs);
  await sendJson(res, files);
}

async function handleFilePath(session, req, res, encodedPath) {
  const path = decodePath(encodedPath);
  const abs = resolvePath(session, path);
  if (req.method === 'GET') {
    const data = await readFile(abs);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(data);
    return;
  }
  if (req.method === 'PUT') {
    const body = await readJson(req);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, String(body?.contents ?? ''), 'utf8');
    const rel = toWorkspaceRelative(session, abs);
    broadcast(session, 'file.change', { path: rel });
    await sendJson(res, { ok: true });
    return;
  }
  if (req.method === 'DELETE') {
    await rm(abs, { recursive: true, force: true });
    const rel = toWorkspaceRelative(session, abs);
    broadcast(session, 'file.change', { path: rel });
    await sendJson(res, { ok: true });
    return;
  }
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'method_not_allowed' }));
}

async function handleMkdir(session, req, res) {
  const body = await readJson(req);
  const abs = resolvePath(session, String(body?.path ?? ''));
  await mkdir(abs, { recursive: true });
  await sendJson(res, { ok: true });
}

async function destroySession(session) {
  for (const process of session.processes.values()) {
    process.child.kill('SIGTERM');
  }
  session.processes.clear();
  if (session.containerId) {
    await runPodman(['rm', '-f', session.containerId]).catch(() => {});
  }
  if (session.watcher) session.watcher.close();
  if (session.pollTimer) clearInterval(session.pollTimer);
  for (const res of session.listeners) {
    try { res.end(); } catch { /* ignore */ }
  }
  session.listeners.clear();
  await rm(session.rootDir, { recursive: true, force: true }).catch(() => {});
  sessions.delete(session.id);
}

async function startContainer(session) {
  const args = [
    'run',
    '--name', `clawless-${session.id}`,
    '--rm',
    '-d',
    '--network', 'none',
    '--workdir', HOME_DIR,
    '-v', `${session.rootDir}:${HOME_DIR}`,
    session.image ?? 'node:20-bookworm-slim',
    'sleep',
    'infinity',
  ];
  const result = await runPodman(args);
  session.containerId = result.stdout.trim();
}

function startWatcher(session) {
  const workspaceDir = join(session.rootDir, 'workspace');
  const scan = async () => {
    const next = await snapshot(workspaceDir, workspaceDir);
    const changed = diffSnapshots(session.snapshot, next);
    session.snapshot = next;
    for (const path of changed) {
      broadcast(session, 'file.change', { path });
    }
  };

  try {
    session.watcher = watch(workspaceDir, { recursive: true }, () => {
      void scan();
    });
  } catch {
    session.pollTimer = setInterval(() => {
      void scan();
    }, 2000);
  }

  void scan();
}

async function writeWorkspaceFiles(session, files) {
  for (const [path, contents] of Object.entries(files)) {
    const abs = resolvePath(session, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, String(contents), 'utf8');
  }
}

async function runCommand(session, request, options) {
  if (!session.containerId) throw new Error('Session not started');
  const args = ['exec', '-i', '-w', request.cwd];
  for (const [key, value] of Object.entries(request.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(session.containerId);
  args.push(request.command, ...(request.args ?? []));

  const child = spawn('podman', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let sawTrailingNewline = false;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout.push(text);
    sawTrailingNewline = text.endsWith('\n') || text.endsWith('\r');
    if (options?.persistent) {
      broadcast(session, 'process.output', { processId: options.processId, chunk: text });
    }
    if (options?.streamToResponse && options.response && !options.response.writableEnded) {
      options.response.write(text);
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderr.push(text);
    sawTrailingNewline = text.endsWith('\n') || text.endsWith('\r');
    if (options?.persistent) {
      broadcast(session, 'process.output', { processId: options.processId, chunk: text });
    }
    if (options?.streamToResponse && options.response && !options.response.writableEnded) {
      options.response.write(text);
    }
  });

  if (options?.persistent) {
    child.on('exit', (code) => {
      session.processes.delete(options.processId);
      broadcast(session, 'process.exit', { processId: options.processId, code: code ?? 0 });
    });
    child.on('error', (error) => {
      broadcast(session, 'process.exit', { processId: options.processId, code: 1, error: error.message });
    });
    return child;
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
  if (options?.streamToResponse && options.response && !options.response.writableEnded && !sawTrailingNewline) {
    options.response.write('\n');
  }
  return { exitCode, stdout: stdout.join('') + stderr.join('') };
}

async function canRunPodman() {
  try {
    await runPodman(['--version']);
    return true;
  } catch {
    return false;
  }
}

function broadcast(session, type, data) {
  for (const res of session.listeners) {
    sendEvent(session, res, type, data);
  }
}

function sendEvent(_session, res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sessionSummary(session) {
  return {
    id: session.id,
    status: session.status,
    image: session.image,
    rootDir: session.rootDir,
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function encodePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function decodePath(path) {
  return path.split('/').map((part) => decodeURIComponent(part)).join('/');
}

function resolvePath(session, path) {
  const clean = path.replace(/^\/+/, '');
  if (clean.startsWith('workspace/')) {
    return join(session.rootDir, clean);
  }
  return join(session.rootDir, clean);
}

function toWorkspaceRelative(session, absPath) {
  const rel = relative(join(session.rootDir, 'workspace'), absPath).replace(/\\/g, '/');
  return rel === '' ? 'workspace' : rel.startsWith('..') ? relative(session.rootDir, absPath).replace(/\\/g, '/') : rel;
}

async function listWorkspace(absDir, rootDir) {
  const results = [];
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(absDir, entry.name);
    const rel = relative(rootDir, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      results.push(`${rel}/`);
      results.push(...await listWorkspace(abs, rootDir));
    } else {
      results.push(rel);
    }
  }
  return results;
}

async function snapshot(absDir, rootDir) {
  const map = new Map();
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(absDir, entry.name);
    const rel = relative(rootDir, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      const nested = await snapshot(abs, rootDir);
      for (const [key, value] of nested) map.set(key, value);
    } else {
      const st = await stat(abs).catch(() => null);
      map.set(rel, `${st?.mtimeMs ?? 0}:${st?.size ?? 0}`);
    }
  }
  return map;
}

function diffSnapshots(prev, next) {
  const changed = [];
  for (const [key, value] of next) {
    if (prev.get(key) !== value) changed.push(key);
  }
  for (const key of prev.keys()) {
    if (!next.has(key)) changed.push(key);
  }
  return [...new Set(changed)];
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function sendJson(res, value, status = 200) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify(value));
}

async function runPodman(args) {
  const child = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve(exitCode ?? 0));
  });
  if (code !== 0) {
    throw new Error(`podman ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return { code, stdout, stderr };
}
