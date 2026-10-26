interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('postMessage', m), getState: () => undefined, setState: () => undefined };

let nextId = 1;
const pending = new Map<number, (v: any) => void>();

/** Sends a message and resolves with the reply carrying the same requestId. */
export function request<T>(msg: Record<string, unknown>): Promise<T> {
  const requestId = nextId++;
  return new Promise<T>((resolve) => {
    pending.set(requestId, resolve);
    vscode.postMessage({ ...msg, requestId });
  });
}

window.addEventListener('message', (e) => {
  const id = e.data?.requestId;
  if (id && pending.has(id)) {
    pending.get(id)!(e.data);
    pending.delete(id);
  }
});

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
