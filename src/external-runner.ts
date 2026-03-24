import type { WebContainer } from '@webcontainer/api';
import type { TerminalManager } from './terminal.js';
import { AuditLog } from './audit.js';
import { NETWORK_HOOK_CJS } from './network-hook.js';
import { GitService, type GitFile } from './git-service.js';
import {
  buildContainerPackageJson,
  buildWorkspaceFiles,
  flattenWorkspaceTree,
  buildStubLoaderHooks,
  buildStubLoaderRegister,
  GIT_STUB_JS,
  OPENCLAW_SETUP_SCRIPT,
  OPENCLAW_START_SCRIPT,
} from './workspace.js';
import { normalizeProviderEnv, serializeEnvFile } from './provider-env.js';
import type { AgentConfig, ContainerEnv, ContainerStatus } from './types.js';
import type { ContainerBootOptions, ExecutionBackend } from './backend.js';
import type { PolicyEngine } from './policy.js';
import type { RunnerNetworkMode } from './types.js';

type RunnerProcessKind = 'shell' | 'gitclaw' | 'agent';

interface RunnerSession {
  id: string;
  status: ContainerStatus;
  image?: string;
}

interface RunnerProcess {
  id: string;
  kind: RunnerProcessKind;
  command: string;
  restartable: boolean;
}

interface StreamCommandResult {
  exitCode: number;
  stdout: string;
}

export class ExternalRunnerClient implements ExecutionBackend {
  readonly runtime = 'external-local' as const;

  private baseUrl: string;
  private _status: ContainerStatus = 'booting';
  private session: RunnerSession | null = null;
  private audit: AuditLog | null = null;
  private statusListener?: (status: ContainerStatus) => void;
  private fileChangeListeners: Array<(path: string) => void> = [];
  private eventSource: EventSource | null = null;
  private activeProcess: RunnerProcess | null = null;
  private activeProcessTerminal: TerminalManager | null = null;
  private activeProcessWriter: WritableStreamDefaultWriter<string> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAction: (() => Promise<void>) | null = null;
  private apiEnvVars: Record<string, string> = {};
  private lastBootOptions: ContainerBootOptions | null = null;
  private gitService: GitService | null = null;
  private networkMode: RunnerNetworkMode;

  constructor(runnerUrl?: string, networkMode: RunnerNetworkMode = 'default') {
    this.baseUrl = normalizeRunnerUrl(runnerUrl ?? localStorage.getItem('clawchef_runnerUrl') ?? 'http://127.0.0.1:6234');
    this.networkMode = networkMode;
  }

  get status(): ContainerStatus {
    return this._status;
  }

  get hasClonedRepo(): boolean {
    return this.gitService !== null;
  }

  setAuditLog(audit: AuditLog): void {
    this.audit = audit;
  }

  setPolicy(policy: PolicyEngine): void {
    void policy;
  }

  setStatusListener(fn: (status: ContainerStatus) => void): void {
    this.statusListener = fn;
  }

  async boot(opts?: ContainerBootOptions): Promise<void> {
    this.lastBootOptions = opts ?? null;
    this.setStatus('booting');
    await this.ensureRunnerAvailable();

    const image = opts?.image ?? 'node:20-bookworm-slim';
    const baseWorkspace = flattenWorkspaceTree(buildWorkspaceFiles(opts?.workspace));
    const workspace: Record<string, string> = {
      'package.json': buildContainerPackageJson({
        agentPackage: opts?.agentPackage,
        agentVersion: opts?.agentVersion,
        extraDeps: opts?.services,
        extraOverrides: opts?.agentOverrides,
      }),
      'git-stub.js': GIT_STUB_JS,
      'network-hook.cjs': NETWORK_HOOK_CJS,
      ...prefixWorkspace(baseWorkspace),
    };

    if (opts?.agentOverrides && Object.keys(opts.agentOverrides).length > 0) {
      workspace['stub-loader.mjs'] = buildStubLoaderRegister(Object.keys(opts.agentOverrides));
      workspace['stub-loader-hooks.mjs'] = buildStubLoaderHooks(Object.keys(opts.agentOverrides));
      workspace['openclaw-start.mjs'] = OPENCLAW_START_SCRIPT;
      workspace['openclaw-setup.cjs'] = OPENCLAW_SETUP_SCRIPT;
    }

    this.session = await this.requestJson<RunnerSession>('/sessions', {
      method: 'POST',
      body: {
        image,
        networkMode: this.networkMode,
        workspace,
        cwd: '/home/clawless',
      },
    });

    this.attachEventStream();
    this.setStatus(this.session.status);
  }

  async runNpmInstall(terminal: TerminalManager): Promise<void> {
    await this.ensureSession();
    this.setStatus('installing');
    const result = await this.streamCommand(terminal, {
      command: 'npm',
      args: ['install', '--legacy-peer-deps', '--ignore-scripts', '--cache', '/tmp/npm-cache'],
      cwd: '/home/clawless',
      env: { HOME: '/home/clawless', PATH: '/home/clawless/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      kind: 'install',
    });
    if (result.exitCode !== 0) {
      this.setStatus('error');
      throw new Error(`npm install failed (exit ${result.exitCode})`);
    }
  }

  async configureEnv(env: ContainerEnv): Promise<void> {
    await this.ensureSession();
    this.apiEnvVars = normalizeProviderEnv(env.provider, env.envVars);

    const openaiKey = this.apiEnvVars['OPENAI_API_KEY'];
    if (openaiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'gpt-4o-realtime-preview' }),
        });
        if (resp.ok) {
          const session = await resp.json() as { client_secret?: { value?: string } };
          const ephemeralKey = session.client_secret?.value;
          if (ephemeralKey) {
            this.apiEnvVars['OPENAI_EPHEMERAL_KEY'] = ephemeralKey;
          }
        }
      } catch {
        // Non-fatal.
      }
    }

    const maskedVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(env.envVars)) {
      maskedVars[key] = AuditLog.maskKey(value);
    }
    this.audit?.log('env.configure', `provider=${env.provider} model=${env.model}`, {
      provider: env.provider,
      model: env.model,
      vars: maskedVars,
    }, { source: 'user' });

    await this.writeFile('workspace/.env', serializeEnvFile(this.apiEnvVars));

    try {
      const yaml = await this.readFile('workspace/agent.yaml');
      const patched = yaml.replace(/preferred:\s*"[^"]*"/, `preferred: "${env.model}"`);
      await this.writeFile('workspace/agent.yaml', patched);
    } catch {
      // Optional file.
    }
  }

  async startGitclaw(terminal: TerminalManager): Promise<void> {
    await this.ensureSession();
    this.setStatus('ready');
    this.restartAction = () => this.startGitclaw(terminal);
    const command = 'node';
    const args = ['node_modules/gitclaw/dist/index.js', '--dir', '/home/clawless/workspace'];
    await this.startPersistentProcess(terminal, {
      kind: 'gitclaw',
      command: [command, ...args].join(' '),
      restartable: true,
      request: { command, args, cwd: '/home/clawless', env: this.runtimeEnv({ PATH: '/home/clawless/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }) },
    });
  }

  async startShell(terminal: TerminalManager): Promise<void> {
    await this.ensureSession();
    this.restartAction = null;
    const command = 'sh';
    await this.startPersistentProcess(terminal, {
      kind: 'shell',
      command,
      restartable: false,
      request: { command, args: [], cwd: '/home/clawless', env: this.runtimeEnv({}) },
    });
  }

  async sendToShell(command: string): Promise<void> {
    if (!this.activeProcess) return;
    await this.requestJson(`/sessions/${this.session!.id}/process/${this.activeProcess.id}/input`, {
      method: 'POST',
      body: { data: command },
    });
  }

  async getServerUrl(_port: number): Promise<string> {
    throw new Error('External-local runtime does not expose forwarded server URLs yet');
  }

  async listWorkspaceFiles(dir = 'workspace'): Promise<string[]> {
    await this.ensureSession();
    const qs = new URLSearchParams({ dir });
    return this.requestJson<string[]>(`/sessions/${this.session!.id}/files?${qs.toString()}`);
  }

  async readFile(path: string): Promise<string> {
    const resp = await this.request(`${this.sessionPath()}/files/${encodePath(path)}`);
    if (!resp.ok) throw new Error(`Failed to read ${path}: ${resp.status} ${resp.statusText}`);
    return resp.text();
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resp = await this.request(`${this.sessionPath()}/files/${encodePath(path)}`);
    if (!resp.ok) throw new Error(`Failed to read ${path}: ${resp.status} ${resp.statusText}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await this.requestJson(`${this.sessionPath()}/files/${encodePath(path)}`, {
      method: 'PUT',
      body: { contents },
    });
    this.fileChangeListeners.forEach((fn) => fn(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.requestJson(`${this.sessionPath()}/mkdir`, {
      method: 'POST',
      body: { path },
    });
  }

  async remove(path: string): Promise<void> {
    await this.request(`${this.sessionPath()}/files/${encodePath(path)}`, { method: 'DELETE' });
  }

  async cloneRepo(url: string, token: string): Promise<void> {
    await this.ensureSession();
    const { owner, repo } = GitService.parseRepoUrl(url);
    this.audit?.log('git.clone', `${owner}/${repo}`, { url }, { source: 'user' });

    const svc = new GitService(token, owner, repo);
    await svc.detectDefaultBranch();
    const files = await svc.fetchRepoTree();
    for (const file of files) {
      const fullPath = `workspace/${file.path}`;
      await this.writeFile(fullPath, file.content);
    }
    this.gitService = svc;
    this.audit?.log('git.clone', `Cloned ${files.length} files from ${owner}/${repo}@${svc.repoBranch}`, {
      owner, repo, branch: svc.repoBranch, fileCount: files.length,
    }, { source: 'system' });
  }

  async syncToRepo(message?: string): Promise<string> {
    if (!this.gitService) throw new Error('No repository cloned');
    const owner = this.gitService.repoOwner;
    const repo = this.gitService.repoName;
    const IGNORED = /^(node_modules\/|\.git\/|\.env$)/;
    const allPaths = await this.listWorkspaceFiles();
    const files: GitFile[] = [];
    for (const relPath of allPaths) {
      if (relPath.endsWith('/')) continue;
      if (IGNORED.test(relPath)) continue;
      try {
        const content = await this.readFile(`workspace/${relPath}`);
        files.push({ path: relPath, content });
      } catch {
        // skip unreadable
      }
    }
    const commitMsg = message ?? `Sync from ClawLess at ${new Date().toISOString()}`;
    const sha = await this.gitService.pushChanges(files, commitMsg);
    this.audit?.log('git.push', `Pushed ${files.length} files to ${owner}/${repo}`, {
      owner, repo, sha, fileCount: files.length,
    }, { source: 'user' });
    return sha;
  }

  async startAgent(config: AgentConfig, terminal: TerminalManager): Promise<void> {
    await this.ensureSession();
    this.setStatus('ready');
    this.restartAction = () => this.startAgent(config, terminal);

    const request =
      config.kind === 'workspace-command' || config.kind === 'external-command'
        ? { command: 'sh', args: ['-lc', config.command ?? ''], cwd: config.workdir ?? '/home/clawless', env: this.runtimeEnv(config.env ?? {}) }
        : {
            command: 'node',
            args: [
              `node_modules/${config.package}/${config.entry}`,
              ...(config.args?.map((arg) => arg.replace('<home>', '/home/clawless')) ?? []),
            ],
            cwd: config.workdir ?? '/home/clawless',
            env: this.runtimeEnv({
              PATH: '/home/clawless/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
              ...config.env,
            }),
          };

    await this.startPersistentProcess(terminal, {
      kind: 'agent',
      command: [request.command, ...(request.args ?? [])].join(' '),
      restartable: true,
      request,
    });
  }

  async runStartupScript(script: string, terminal: TerminalManager): Promise<void> {
    const result = await this.streamCommand(terminal, {
      command: 'sh',
      args: ['-lc', `cd workspace && ${script}`],
      cwd: '/home/clawless',
      env: this.runtimeEnv({}),
      kind: 'startup',
    });
    if (result.exitCode !== 0) {
      throw new Error(`Startup script failed (exit ${result.exitCode})`);
    }
  }

  async exec(cmd: string): Promise<string> {
    const result = await this.streamCommand(null, {
      command: 'sh',
      args: ['-lc', cmd],
      cwd: '/home/clawless',
      env: this.runtimeEnv({}),
      kind: 'exec',
    });
    return result.stdout.trimEnd();
  }

  startWatching(): void {
    this.attachEventStream();
  }

  onFileChange(fn: (path: string) => void): void {
    this.fileChangeListeners.push(fn);
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.activeProcess = null;
    this.activeProcessWriter = null;
    this.restartAction = null;
    await this.request(`${this.sessionPath()}`, { method: 'DELETE' }).catch(() => {});
    this.session = null;
    this.setStatus('booting');
  }

  async restart(): Promise<void> {
    const last = this.lastBootOptions;
    await this.stop();
    if (last) await this.boot(last);
  }

  getWebContainer(): WebContainer | null {
    return null;
  }

  private setStatus(status: ContainerStatus): void {
    this._status = status;
    this.statusListener?.(status);
  }

  private sessionPath(): string {
    if (!this.session) throw new Error('Runner session not booted');
    return `${this.baseUrl}/sessions/${this.session.id}`;
  }

  private async ensureSession(): Promise<void> {
    if (!this.session) {
      await this.boot(this.lastBootOptions ?? undefined);
    }
  }

  private runtimeEnv(extra: Record<string, string>): Record<string, string> {
    const env = { ...this.apiEnvVars, ...extra };
    const nodeOptions = [this.nodeOptions(), extra.NODE_OPTIONS].filter(Boolean).join(' ').trim();
    if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
    return env;
  }

  private nodeOptions(): string {
    const parts = ['--require /home/clawless/network-hook.cjs'];
    if (this.lastBootOptions?.agentOverrides && Object.keys(this.lastBootOptions.agentOverrides).length > 0) {
      parts.push('--import /home/clawless/stub-loader.mjs');
    }
    return parts.join(' ');
  }

  private async startPersistentProcess(
    terminal: TerminalManager,
    spec: {
      kind: RunnerProcessKind;
      command: string;
      restartable: boolean;
      request: { command: string; args: string[]; cwd: string; env: Record<string, string> };
    },
  ): Promise<void> {
    const resp = await this.requestJson<{ id: string }>(`${this.sessionPath()}/process`, {
      method: 'POST',
      body: spec.request,
    });
    this.activeProcess = {
      id: resp.id,
      kind: spec.kind,
      command: spec.command,
      restartable: spec.restartable,
    };
    this.activeProcessTerminal = terminal;
    terminal.onData((data) => {
      if (this.activeProcessWriter) {
        this.activeProcessWriter.write(data);
      } else if (this.activeProcess) {
        void this.sendToShell(data);
      }
    });
    this.attachEventStream();
  }

  private async streamCommand(
    terminal: TerminalManager | null,
    request: { command: string; args: string[]; cwd: string; env: Record<string, string>; kind: string },
  ): Promise<StreamCommandResult> {
    const resp = await this.request(`${this.sessionPath()}/exec`, {
      method: 'POST',
      body: request,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Command failed: ${resp.status} ${resp.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let stdout = '';
    let exitCode = 0;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith('__EXIT__:')) {
          exitCode = Number(line.slice('__EXIT__:'.length)) || 0;
          continue;
        }
        stdout += line + '\n';
        terminal?.write(line + '\n');
      }
    }

    if (buffer.length > 0) {
      const markerIndex = buffer.indexOf('__EXIT__:');
      if (markerIndex !== -1) {
        const before = buffer.slice(0, markerIndex);
        if (before) {
          stdout += before;
          terminal?.write(before);
        }
        exitCode = Number(buffer.slice(markerIndex + '__EXIT__:'.length).trim()) || 0;
      } else {
        stdout += buffer;
        terminal?.write(buffer);
      }
    }

    return { exitCode, stdout };
  }

  private attachEventStream(): void {
    if (!this.session || this.eventSource) return;
    this.eventSource = new EventSource(`${this.sessionPath()}/events`);
    this.eventSource.addEventListener('session.status', (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { status: ContainerStatus };
      this.setStatus(data.status);
    });
    this.eventSource.addEventListener('process.output', (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { processId: string; chunk: string };
      if (this.activeProcess?.id === data.processId && this.activeProcessTerminal) {
        this.activeProcessTerminal.write(data.chunk);
      }
    });
    this.eventSource.addEventListener('process.exit', (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { processId: string; code: number };
      if (this.activeProcess?.id !== data.processId) return;
      if (this.activeProcess.kind === 'shell') {
        this.activeProcess = null;
        this.activeProcessTerminal = null;
        this.activeProcessWriter = null;
        this.restartAction = null;
        return;
      }
      if (this.restartAction && this.restartTimer == null) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.activeProcessTerminal) return;
          this.activeProcess = null;
          this.activeProcessWriter = null;
          void this.restartAction?.();
        }, 2000);
      }
    });
    this.eventSource.addEventListener('file.change', (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { path: string };
      this.fileChangeListeners.forEach((fn) => fn(data.path));
    });
    this.eventSource.onerror = () => {
      // Let the browser retry automatically; no hard failure needed here.
    };
  }

  private async request(path: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}): Promise<Response> {
    const body = normalizeRequestBody(init.body);
    try {
      return await fetch(normalizePath(this.baseUrl, path), {
        ...init,
        body,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw this.runnerUnavailableError(error);
    }
  }

  private async requestJson<T>(path: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}): Promise<T> {
    const resp = await this.request(path, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Runner API ${resp.status}: ${resp.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`);
    }
    if (resp.status === 204) return undefined as T;
    return resp.json() as Promise<T>;
  }

  private async ensureRunnerAvailable(): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`);
      if (!resp.ok) {
        throw new Error(`health check returned ${resp.status} ${resp.statusText}`.trim());
      }
      const health = await resp.json() as { ok?: boolean; engine?: string | null; podman?: boolean; docker?: boolean };
      if (!health.engine) {
        throw new Error('No container engine is available on this machine');
      }
    } catch (error) {
      throw this.runnerUnavailableError(error);
    }
  }

  private runnerUnavailableError(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(
      `External runner daemon unavailable at ${this.baseUrl}. Start it with \`npm run locald\` or \`npm run dev:all\`. ${detail}`.trim(),
    );
  }
}

function normalizeRunnerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizePath(baseUrl: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function normalizeRequestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (
    typeof body === 'string' ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return body as BodyInit;
  }
  return JSON.stringify(body);
}

function prefixWorkspace(files: Record<string, string>): Record<string, string> {
  const prefixed: Record<string, string> = {};
  for (const [path, contents] of Object.entries(files)) {
    prefixed[`workspace/${path}`] = contents;
  }
  return prefixed;
}
