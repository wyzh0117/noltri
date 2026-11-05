import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test-only runner: synthetic in-memory page, owned server and fresh Chrome profile.
export function createReviewBrowser(harness: string, resolveDir: string) {
  let server: Server;
  let chrome: ChildProcess;
  let profile: string;
  let socket: WebSocket;
  let sessionId: string;
  let requestId = 0;
  const errors: string[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  function cdp(method: string, params: object = {}, session?: string): Promise<any> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }
  async function evaluate<T = any>(expression: string): Promise<T> {
    const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
    return response.result.value;
  }
  async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 2_000): Promise<T> {
    const end = Date.now() + timeout;
    let value: T;
    do {
      value = await read();
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < end);
    throw new Error('Timed out waiting for component state: ' + JSON.stringify(value!));
  }

  async function start(): Promise<void> {
    const binary = process.env.CHROME_BIN ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    ].find(existsSync);
    if (!binary) throw new Error('WorkbenchInbox interaction tests require installed Chrome/Chromium; set CHROME_BIN.');
    const bundle = await build({ stdin: { contents: harness, loader: 'tsx', resolveDir }, bundle: true, write: false, jsx: 'automatic', format: 'esm', loader: { '.css': 'empty' } });
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
      else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><div id="root"></div><script type="module" src="/bundle.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = await mkdtemp(join(tmpdir(), 'noltri-inbox-test-'));
    chrome = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const port = await until(async () => { try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); } catch { return []; } }, value => value.length >= 2, 10_000);
    socket = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(Error('Unable to connect isolated headless Chrome')); });
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (!message.id) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(Error(message.error.message)); else waiter?.resolve(message.result);
    };
    const target = await cdp('Target.createTarget', { url: 'about:blank' });
    sessionId = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.navigate', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, sessionId);
    await until(() => evaluate<boolean>('!!window.harness'), Boolean, 5_000);
  }

  async function close(): Promise<void> {
    if (socket?.readyState === WebSocket.OPEN) await cdp('Browser.close').catch(() => undefined);
    socket?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await new Promise<void>(resolve => { chrome.once('exit', () => resolve()); setTimeout(resolve, 2_000).unref(); });
    }
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return { start, close, evaluate, until, errors };
}
