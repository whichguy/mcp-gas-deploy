/**
 * Chrome DevTools Protocol (CDP) client
 *
 * Minimal implementation of the ChromeDevtools interface using Chrome's
 * remote debugging WebSocket API (--remote-debugging-port=9222).
 * Allows the fork tool to do GCP switch without the chrome-devtools MCP.
 */

import type { ChromeDevtools } from './gcpSwitch.js';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;

interface CdpTarget {
  id: string;
  type: string;
  webSocketDebuggerUrl: string;
  url: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/**
 * Create a CDP client connected to the first available page target.
 * Returns null if Chrome is not reachable on the debug port.
 */
export async function createCdpClient(): Promise<ChromeDevtools | null> {
  // Fetch available targets
  let targets: CdpTarget[];
  try {
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    targets = await res.json() as CdpTarget[];
  } catch {
    return null; // Chrome not running with remote debugging
  }

  const pageTarget = targets.find(t => t.type === 'page') ?? targets[0];
  if (!pageTarget?.webSocketDebuggerUrl) return null;

  return new CdpClient(pageTarget.webSocketDebuggerUrl);
}

class CdpClient implements ChromeDevtools {
  private wsUrl: string;
  private msgId = 1;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  async navigate_page(args: { url: string }): Promise<unknown> {
    return this.sendAndWait('Page.navigate', { url: args.url }, 8000);
  }

  async evaluate_script(args: { expression: string }): Promise<{ result?: string }> {
    const res = await this.sendAndWait('Runtime.evaluate', {
      expression: args.expression,
      awaitPromise: true,
      returnByValue: true,
    }, 15000) as Record<string, unknown> | null;

    const resultObj = res?.result as Record<string, unknown> | undefined;
    const value = resultObj?.value;
    return { result: value !== undefined ? String(value) : undefined };
  }

  private sendAndWait(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP timeout waiting for response to ${method}`));
      }, timeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify({ id, method, params }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as CdpMessage;
          if (msg.id === id) {
            clearTimeout(timer);
            ws.close();
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              resolve(msg.result ?? null);
            }
          }
        } catch { /* ignore non-matching messages */ }
      };

      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${String(err)}`));
      };
    });
  }
}
