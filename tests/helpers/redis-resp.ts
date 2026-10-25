// A minimal Redis client over node:net, enough to EVAL a script and read the
// reply. It exists so the Redis integration test needs no client package: it
// speaks RESP2 directly and satisfies RedisLike from @corridor/service.

import { connect, type Socket } from "node:net";

type Reply = string | number | null | Reply[] | Error;

/** Parse one RESP2 value from `buf` at `at`; null when the buffer is incomplete. */
function parse(buf: Buffer, at: number): { value: Reply; next: number } | null {
  const eol = buf.indexOf("\r\n", at);
  if (eol < 0) return null;
  const line = buf.toString("utf8", at + 1, eol);
  const after = eol + 2;
  switch (String.fromCharCode(buf[at]!)) {
    case "+":
      return { value: line, next: after };
    case "-":
      return { value: new Error(line), next: after };
    case ":":
      return { value: Number(line), next: after };
    case "$": {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString("utf8", after, after + len), next: after + len + 2 };
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return { value: null, next: after };
      const items: Reply[] = [];
      let pos = after;
      for (let i = 0; i < n; i++) {
        const item = parse(buf, pos);
        if (!item) return null;
        items.push(item.value);
        pos = item.next;
      }
      return { value: items, next: pos };
    }
    default:
      throw new Error(`unexpected RESP type byte at ${at}`);
  }
}

export class RespClient {
  private readonly waiting: ((r: Reply) => void)[] = [];
  private buf = Buffer.alloc(0);

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const parsed = parse(this.buf, 0);
        if (!parsed) return;
        this.buf = this.buf.subarray(parsed.next);
        this.waiting.shift()?.(parsed.value);
      }
    });
  }

  static connect(url: string): Promise<RespClient> {
    const { hostname, port } = new URL(url);
    return new Promise((resolve, reject) => {
      const socket = connect({ host: hostname, port: Number(port || 6379) });
      socket.once("error", reject);
      socket.once("connect", () => resolve(new RespClient(socket)));
    });
  }

  command(...args: (string | number)[]): Promise<Reply> {
    const parts = args.map((a) => {
      const s = String(a);
      return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
    });
    return new Promise((resolve, reject) => {
      this.waiting.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
      this.socket.write(`*${args.length}\r\n${parts.join("")}`);
    });
  }

  /** The `RedisLike` shape from @corridor/service. */
  eval = (script: string, keys: string[], args: (string | number)[]): Promise<unknown> =>
    this.command("EVAL", script, keys.length, ...keys, ...args);

  close(): void {
    this.socket.end();
  }
}
