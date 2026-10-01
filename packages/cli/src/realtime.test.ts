import { describe, expect, it, vi } from "vitest";

import {
  RealtimeClient,
  realtimeSocketUrl,
  reconnectDelayMs,
  type RealtimeMessage,
  type RealtimeSocket,
  type RealtimeState,
} from "./realtime.js";

class FakeSocket implements RealtimeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closeCount = 0;
  private readonly listeners = new Map<
    string,
    ((event: RealtimeMessage) => void)[]
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(
    type: string,
    listener: (event: RealtimeMessage) => void
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private dispatch(type: string, event: RealtimeMessage = { data: undefined }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open");
  }

  message(value: unknown): void {
    this.dispatch("message", { data: JSON.stringify(value) });
  }

  rawMessage(data: unknown): void {
    this.dispatch("message", { data });
  }

  fail(): void {
    this.dispatch("error");
    this.close();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCount += 1;
    this.dispatch("close");
  }
}

function harness(options: {
  reconnect?: { initialMs?: number; maxMs?: number };
  pingIntervalMs?: number;
  failFirst?: boolean;
}) {
  const sockets: FakeSocket[] = [];
  const states: RealtimeState[] = [];
  const events: unknown[] = [];
  let attempts = 0;
  const client = new RealtimeClient({
    url: "ws://example.test/workspaces/org/realtime?token=k",
    createSocket: () => {
      attempts += 1;
      if (options.failFirst && attempts === 1) {
        throw new Error("connect failed");
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event),
    onStateChange: (state) => states.push(state),
    reconnect: options.reconnect,
    pingIntervalMs: options.pingIntervalMs,
    random: () => 0,
  });
  return { client, sockets, states, events };
}

describe("realtimeSocketUrl", () => {
  it("converts http/https base URLs to ws/wss and passes the token", () => {
    expect(realtimeSocketUrl("http://127.0.0.1:8787", "org_1", "key")).toBe(
      "ws://127.0.0.1:8787/workspaces/org_1/realtime?token=key"
    );
    const secure = new URL(
      realtimeSocketUrl("https://pile.example.com/", "org_2", "k e/y")
    );
    expect(secure.protocol).toBe("wss:");
    expect(secure.pathname).toBe("/workspaces/org_2/realtime");
    expect(secure.searchParams.get("token")).toBe("k e/y");
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps at maxMs", () => {
    const zeroJitter = { initialMs: 100, maxMs: 500, random: () => 0 };
    expect(reconnectDelayMs(0, zeroJitter)).toBe(100);
    expect(reconnectDelayMs(1, zeroJitter)).toBe(200);
    expect(reconnectDelayMs(2, zeroJitter)).toBe(400);
    expect(reconnectDelayMs(3, zeroJitter)).toBe(500);
    expect(reconnectDelayMs(9, zeroJitter)).toBe(500);
    expect(reconnectDelayMs(0, { initialMs: 100, random: () => 0.5 })).toBe(
      150
    );
  });
});

describe("RealtimeClient", () => {
  it("reports open and forwards parsed object events", () => {
    const { client, sockets, states, events } = harness({});
    client.start();
    expect(states).toEqual(["connecting"]);
    const socket = sockets[0];
    expect(socket).toBeDefined();
    socket!.open();
    expect(states).toEqual(["connecting", "open"]);
    expect(client.isOpen).toBe(true);

    socket!.message({ type: "connected", organizationId: "org" });
    socket!.message({ type: "agent_session.updated", session: { id: "s" } });
    socket!.rawMessage("not json");
    socket!.rawMessage(42);
    socket!.rawMessage("[1,2]");
    expect(events).toEqual([
      { type: "connected", organizationId: "org" },
      { type: "agent_session.updated", session: { id: "s" } },
    ]);
    client.close();
  });

  it("reconnects after the socket closes", async () => {
    const { client, sockets, states } = harness({
      reconnect: { initialMs: 10 },
    });
    client.start();
    sockets[0]!.open();
    sockets[0]!.close();
    expect(states.at(-1)).toBe("reconnecting");
    expect(client.isOpen).toBe(false);

    await vi.waitFor(() => expect(sockets.length).toBe(2), {
      timeout: 2000,
      interval: 5,
    });
    sockets[1]!.open();
    expect(states.at(-1)).toBe("open");
    client.close();
  });

  it("reconnects when the socket factory throws", async () => {
    const { client, sockets } = harness({
      reconnect: { initialMs: 10 },
      failFirst: true,
    });
    client.start();
    await vi.waitFor(() => expect(sockets.length).toBe(1), {
      timeout: 2000,
      interval: 5,
    });
    client.close();
  });

  it("does not reconnect after close()", async () => {
    const { client, sockets } = harness({
      reconnect: { initialMs: 5 },
    });
    client.start();
    sockets[0]!.open();
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets.length).toBe(1);
  });

  it("sends pings and drops the socket when the pong never arrives", async () => {
    const { client, sockets } = harness({
      reconnect: { initialMs: 5 },
      pingIntervalMs: 15,
    });
    client.start();
    const socket = sockets[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toContain('{"type":"ping"}'), {
      timeout: 2000,
      interval: 5,
    });
    // No pong: the next interval closes the dead socket and reconnects.
    await vi.waitFor(() => expect(socket.closeCount).toBe(1), {
      timeout: 2000,
      interval: 5,
    });
    await vi.waitFor(() => expect(sockets.length).toBe(2), {
      timeout: 2000,
      interval: 5,
    });
    client.close();
  });

  it("keeps the socket while pongs arrive", async () => {
    const { client, sockets } = harness({
      reconnect: { initialMs: 5 },
      pingIntervalMs: 40,
    });
    client.start();
    const socket = sockets[0]!;
    socket.open();
    // Answer pings quickly — well inside the 40ms heartbeat window.
    const answer = () => {
      if (socket.readyState !== 1) return;
      if (socket.sent.length > 0) socket.message({ type: "pong" });
      setTimeout(answer, 5);
    };
    setTimeout(answer, 5);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.closeCount).toBe(0);
    expect(sockets.length).toBe(1);
    client.close();
  });
});
