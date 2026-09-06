import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

import type { RuntimePaths } from '../shared/contracts.js';

export interface TeleportService {
  run<T = unknown>(args: string[], request?: unknown, timeout?: number): Promise<T>;
  raw(args: string[], timeout?: number): Promise<string>;
  close(): Promise<void>;
}

interface Request {
  id: number;
  args: string[];
  input: string;
  timeout: number;
  resolve(value: string): void;
  reject(error: Error): void;
}

export function createTeleport(runtime: RuntimePaths, size = 3, workerFile = path.join(__dirname, 'teleport-worker.js')): TeleportService {
  if (!Number.isInteger(size) || size < 1) throw new Error('Teleport worker count must be positive.');
  let closed = false;
  let nextId = 1;
  const pending: Request[] = [];
  const slots = Array.from({ length: size }, createSlot);

  function createSlot() {
    let worker: Worker | undefined;
    let active: Request | undefined;
    let timer: NodeJS.Timeout | undefined;
    let workerError: Error | undefined;
    let retiring = false;

    function dispatch() {
      if (closed || retiring || active || !pending.length) return;
      active = pending.shift();
      if (!active) return;
      if (!worker) {
        workerError = undefined;
        try { worker = new Worker(workerFile, { workerData: runtime }); }
        catch (error) {
          const request = active; active = undefined;
          request.reject(error instanceof Error ? error : new Error(String(error)));
          dispatch();
          return;
        }
        worker.unref();
        worker.on('message', ({ id, output, error }) => {
          if (!active || id !== active.id) return;
          if (timer) clearTimeout(timer);
          const request = active;
          active = undefined;
          error ? request.reject(new Error(error)) : request.resolve(output);
          dispatch();
        });
        worker.on('error', error => { workerError = error instanceof Error ? error : new Error(String(error)); });
        worker.on('exit', code => {
          if (timer) clearTimeout(timer);
          worker = undefined;
          retiring = false;
          if (active) {
            const request = active;
            active = undefined;
            request.reject(workerError || new Error(`Teleport worker exited with status ${code}.`));
          }
          dispatch();
        });
      }
      timer = setTimeout(() => {
        if (!active) return;
        const request = active;
        active = undefined;
        retiring = true;
        request.reject(new Error(`Teleport command timed out after ${request.timeout}ms.`));
        void worker?.terminate();
      }, active.timeout);
      try { worker.postMessage({ id: active.id, argv: active.args, input: active.input }); }
      catch (error) {
        if (timer) clearTimeout(timer);
        const request = active; active = undefined;
        retiring = true;
        request.reject(error instanceof Error ? error : new Error(String(error)));
        void worker.terminate();
      }
    }

    async function close() {
      if (timer) clearTimeout(timer);
      if (active) active.reject(new Error('Teleport service closed.'));
      active = undefined;
      if (worker) await worker.terminate();
    }
    return { dispatch, close };
  }

  function enqueue(args: string[], input: string, timeout = 540000): Promise<string> {
    validateArgs(args);
    if (closed) return Promise.reject(new Error('Teleport service closed.'));
    return new Promise((resolve, reject) => {
      pending.push({ id: nextId++, args, input, timeout, resolve, reject });
      for (const slot of slots) slot.dispatch();
    });
  }

  return {
    raw: (args, timeout) => enqueue(args, '', timeout),
    async run<T>(args: string[], request?: unknown, timeout?: number) {
      const output = await enqueue(args, request === undefined ? '' : JSON.stringify(request), timeout);
      try { return JSON.parse(output) as T; }
      catch { throw new Error('Teleport returned an unreadable response.'); }
    },
    async close() {
      if (closed) return;
      closed = true;
      const error = new Error('Teleport service closed.');
      while (pending.length) pending.shift()?.reject(error);
      await Promise.all(slots.map(slot => slot.close()));
    },
  };
}

function validateArgs(args: unknown): asserts args is string[] {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.length > 100000)) throw new Error('Invalid Abra command arguments.');
}
