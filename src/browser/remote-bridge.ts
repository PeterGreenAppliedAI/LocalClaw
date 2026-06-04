/**
 * Remote browser bridge — forwards browser tool commands to a connected
 * Chrome extension and waits for results.
 *
 * The browser tool calls `sendAction()` which queues a command and returns
 * a promise. The extension polls `getPendingAction()`, executes it via
 * content script, and calls `resolveAction()` with the result.
 *
 * Same pattern as Docker backend for exec — code controls flow,
 * remote endpoint is a dumb executor.
 */

export interface BrowserAction {
  id: string;
  action: string;
  ref?: string;
  text?: string;
  url?: string;
  direction?: string;
  selector?: string;
}

export interface BrowserActionResult {
  id: string;
  success: boolean;
  result: string;
}

interface PendingAction {
  action: BrowserAction;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const ACTION_TIMEOUT_MS = 30_000;

class RemoteBrowserBridge {
  private pending: PendingAction | null = null;
  private connected = false;

  /** Mark extension as connected */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected && this.pending) {
      this.pending.reject(new Error('Extension disconnected'));
      clearTimeout(this.pending.timeoutId);
      this.pending = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Called by browser tool — queues action and waits for extension to execute it */
  sendAction(action: Omit<BrowserAction, 'id'>): Promise<string> {
    if (!this.connected) {
      return Promise.reject(new Error('No extension connected'));
    }

    const id = `ba_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const fullAction: BrowserAction = { id, ...action };

    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pending?.action.id === id) {
          this.pending = null;
          reject(new Error(`Browser action timed out: ${action.action}`));
        }
      }, ACTION_TIMEOUT_MS);

      this.pending = { action: fullAction, resolve, reject, timeoutId };
    });
  }

  /** Called by extension polling — returns pending action or null */
  getPendingAction(): BrowserAction | null {
    return this.pending?.action ?? null;
  }

  /** Called by extension after executing action */
  resolveAction(result: BrowserActionResult): void {
    if (!this.pending || this.pending.action.id !== result.id) return;

    clearTimeout(this.pending.timeoutId);
    if (result.success) {
      this.pending.resolve(result.result);
    } else {
      this.pending.reject(new Error(result.result));
    }
    this.pending = null;
  }
}

/** Singleton — shared between browser tool and console API */
export const remoteBridge = new RemoteBrowserBridge();
