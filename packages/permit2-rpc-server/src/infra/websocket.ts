/** Runtime-neutral message relay; adapters own upgrades and connection lifetime. */
export interface RawSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export class SocketPeer {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(private readonly socket: RawSocket) {
    socket.addEventListener("open", () => this.onopen?.());
    socket.addEventListener("message", (event) => this.onmessage?.({ data: (event as MessageEvent).data }));
    socket.addEventListener("error", () => this.onerror?.());
    socket.addEventListener("close", () => this.onclose?.());
  }
  get readyState() {
    return this.socket.readyState;
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    this.socket.send(data);
  }
  close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }
}

export function openWebSocket(url: string, timeoutMs: number): Promise<SocketPeer> {
  return new Promise((resolve, reject) => {
    const raw = new WebSocket(url);
    raw.binaryType = "arraybuffer";
    const socket = new SocketPeer(raw);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Upstream WebSocket connection timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.onopen = socket.onerror = socket.onclose = null;
    };
    socket.onopen = () => {
      cleanup();
      resolve(socket);
    };
    socket.onerror = () => {
      cleanup();
      socket.close();
      reject(new Error("Upstream WebSocket connection failed."));
    };
    socket.onclose = () => {
      cleanup();
      reject(new Error("Upstream WebSocket closed before opening."));
    };
  });
}
