import type { WebContainer } from '@webcontainer/api';
import type { TerminalManager } from './terminal.js';
import type { AuditLog } from './audit.js';
import type { PolicyEngine } from './policy.js';
import type { AgentConfig, ContainerEnv, ContainerStatus, RuntimeKind } from './types.js';

export interface ContainerBootOptions {
  workspace?: Record<string, string>;
  services?: Record<string, string>;
  agentPackage?: string;
  agentVersion?: string;
  agentOverrides?: Record<string, string>;
  image?: string;
}

export interface ExecutionBackend {
  readonly runtime: RuntimeKind;
  readonly status: ContainerStatus;
  readonly hasClonedRepo: boolean;

  setAuditLog(audit: AuditLog): void;
  setPolicy(policy: PolicyEngine): void;
  setStatusListener(fn: (status: ContainerStatus) => void): void;

  boot(opts?: ContainerBootOptions): Promise<void>;
  runNpmInstall(terminal: TerminalManager): Promise<void>;
  configureEnv(env: ContainerEnv): Promise<void>;
  startGitclaw(terminal: TerminalManager): Promise<void>;
  startShell(terminal: TerminalManager): Promise<void>;
  sendToShell(command: string): Promise<void>;
  getServerUrl(port: number): Promise<string>;
  listWorkspaceFiles(dir?: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  cloneRepo(url: string, token: string): Promise<void>;
  syncToRepo(message?: string): Promise<string>;
  startAgent(config: AgentConfig, terminal: TerminalManager): Promise<void>;
  runStartupScript(script: string, terminal: TerminalManager): Promise<void>;
  exec(cmd: string): Promise<string>;
  startWatching(): void;
  onFileChange(fn: (path: string) => void): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getWebContainer(): WebContainer | null;
}
