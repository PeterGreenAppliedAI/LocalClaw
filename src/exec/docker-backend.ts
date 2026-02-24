import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { DockerConfig } from '../config/types.js';

const CONTAINER_NAME = 'localclaw-sandbox';

export class DockerBackend {
  private config: Required<DockerConfig>;
  private running = false;

  constructor(config?: Partial<DockerConfig>) {
    this.config = {
      image: config?.image ?? 'localclaw-sandbox:latest',
      mountMode: config?.mountMode ?? 'ro',
      memoryLimit: config?.memoryLimit ?? '512m',
      cpuLimit: config?.cpuLimit ?? '1.0',
      networkMode: config?.networkMode ?? 'none',
    };
  }

  /**
   * Check if Docker is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('docker', ['info'], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Ensure the sandbox container is running. Idempotent.
   */
  async ensureRunning(): Promise<void> {
    if (this.running) return;

    // Check if container already exists
    const exists = await this.containerExists();
    if (exists) {
      const isRunning = await this.containerIsRunning();
      if (isRunning) {
        this.running = true;
        return;
      }
      // Container exists but stopped — start it
      await this.dockerCommand(['start', CONTAINER_NAME]);
      this.running = true;
      return;
    }

    // Create and start container
    const workspacePath = process.cwd();
    const args = [
      'run', '-d',
      '--name', CONTAINER_NAME,
      `--memory=${this.config.memoryLimit}`,
      `--cpus=${this.config.cpuLimit}`,
      `--network=${this.config.networkMode}`,
      '-v', `${workspacePath}:/workspace:${this.config.mountMode}`,
      this.config.image,
      'tail', '-f', '/dev/null',
    ];

    await this.dockerCommand(args);
    this.running = true;
  }

  /**
   * Execute a command inside the container.
   */
  async exec(command: string, args: string[], timeout = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.ensureRunning();

    return new Promise((resolve) => {
      const fullArgs = ['exec', CONTAINER_NAME, command, ...args];
      execFile('docker', fullArgs, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err ? ((err as any).code ?? 1) : 0,
        });
      });
    });
  }

  /**
   * Spawn an interactive session inside the container.
   * Returns a ChildProcess with stdin/stdout/stderr pipes.
   */
  spawnSession(runtime: string): ChildProcess {
    const runtimeArgs = this.getRuntimeArgs(runtime);
    return spawn('docker', ['exec', '-i', CONTAINER_NAME, ...runtimeArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Stop and remove the container.
   */
  async shutdown(): Promise<void> {
    if (!this.running && !(await this.containerExists())) return;

    try {
      await this.dockerCommand(['stop', '-t', '5', CONTAINER_NAME]);
    } catch { /* may already be stopped */ }

    try {
      await this.dockerCommand(['rm', '-f', CONTAINER_NAME]);
    } catch { /* may already be removed */ }

    this.running = false;
  }

  private getRuntimeArgs(runtime: string): string[] {
    switch (runtime) {
      case 'python':
        return ['python3', '-u', '-i'];
      case 'node':
        return ['node', '--interactive'];
      case 'bash':
        return ['bash', '--norc'];
      default:
        return [runtime];
    }
  }

  private async containerExists(): Promise<boolean> {
    try {
      const result = await this.dockerCommand(
        ['container', 'inspect', CONTAINER_NAME],
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async containerIsRunning(): Promise<boolean> {
    try {
      const result = await this.dockerCommand([
        'container', 'inspect', '-f', '{{.State.Running}}', CONTAINER_NAME,
      ]);
      return result.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private dockerCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      execFile('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) {
          reject(err);
          return;
        }
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err ? ((err as any).code ?? 1) : 0,
        });
      });
    });
  }
}
