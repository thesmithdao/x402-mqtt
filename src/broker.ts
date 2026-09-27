import { randomBytes } from "node:crypto";
import net from "node:net";
import { Aedes, type Client } from "aedes";
import { CATALOG_TOPIC, REQUEST_PREFIX, RESPONSE_PREFIX } from "./spec.js";

export type BuiltInBroker = { url: string; username: string; password: string; close: () => Promise<void> };

type Role = "bridge" | "buyer";

function ownsResponseTopic(clientId: string, topic: string): boolean {
  const own = `${RESPONSE_PREFIX}${clientId}/`;
  if (!topic.startsWith(own) || topic.includes("+")) return false;
  const hash = topic.indexOf("#");
  return hash === -1 || hash === topic.length - 1;
}

export async function startBuiltInBroker(options: { host?: string; port?: number } = {}): Promise<BuiltInBroker> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 1883;
  const username = "x402-bridge";
  const password = randomBytes(24).toString("base64url");
  const roles = new WeakMap<Client, Role>();

  const broker = await Aedes.createBroker({
    authenticate(client, user, pass, done) {
      if (user === undefined) {
        roles.set(client, "buyer");
        return done(null, true);
      }
      if (user === username && pass?.toString() === password) {
        roles.set(client, "bridge");
        return done(null, true);
      }
      const error = Object.assign(new Error("bad username or password"), { returnCode: 4 });
      done(error, false);
    },
    authorizePublish(client, packet, callback) {
      const role = client ? roles.get(client) : "bridge";
      if (role === "bridge") return callback(null);
      if (packet.topic.startsWith(REQUEST_PREFIX)) return callback(null);
      callback(new Error("not allowed"));
    },
    authorizeSubscribe(client, subscription, callback) {
      const role = roles.get(client);
      if (role === "bridge") return callback(null, subscription);
      if (subscription.topic === CATALOG_TOPIC) return callback(null, subscription);
      if (ownsResponseTopic(client.id, subscription.topic)) return callback(null, subscription);
      callback(null, null);
    },
  });

  const server = net.createServer(broker.handle as unknown as (socket: net.Socket) => void);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    url: `mqtt://${host}:${port}`,
    username,
    password,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => broker.close(() => resolve()));
      }),
  };
}

