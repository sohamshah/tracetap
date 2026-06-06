import * as http from "http";
import * as https from "https";
import { AddressInfo } from "net";
import { TrafficLogger, redactSensitiveHeaders } from "./logger";
import { RawPair } from "./types";

export interface ProxyOptions {
  upstreamHost: string;
  upstreamPort: number;
  upstreamProtocol: "https:" | "http:";
  logger: TrafficLogger;
  includeAllRequests: boolean;
  // Decides which request paths to log when not in include-all mode. Defaults
  // to Anthropic's /v1/messages. The codex tracer passes a matcher for the
  // OpenAI Responses endpoint (/responses).
  logPathMatcher?: (pathname: string) => boolean;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // We strip content-length: upstream's value won't match if encoding changes.
  "content-length",
  // Drop content-encoding so we can buffer for logging without re-compressing for the client.
  "content-encoding",
]);

function shouldLogPath(
  pathname: string,
  includeAllRequests: boolean,
  matcher?: (pathname: string) => boolean,
): boolean {
  if (includeAllRequests) return true;
  if (matcher) return matcher(pathname);
  return pathname.startsWith("/v1/messages");
}

function parseRequestBodyForLog(buf: Buffer, contentType: string | undefined): any {
  if (buf.length === 0) return null;
  const text = buf.toString("utf-8");
  if (contentType && contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function parseResponseBodyForLog(
  buf: Buffer,
  contentType: string | undefined,
): { body?: any; body_raw?: string } {
  if (buf.length === 0) return {};
  const text = buf.toString("utf-8");
  if (contentType && contentType.includes("application/json")) {
    try {
      return { body: JSON.parse(text) };
    } catch {
      return { body_raw: text };
    }
  }
  return { body_raw: text };
}

export function createProxyServer(opts: ProxyOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const { upstreamHost, upstreamPort, upstreamProtocol, logger, includeAllRequests, logPathMatcher } = opts;
  const upstreamAgent =
    upstreamProtocol === "https:"
      ? new https.Agent({ keepAlive: true })
      : new http.Agent({ keepAlive: true });
  const upstreamRequest = upstreamProtocol === "https:" ? https.request : http.request;

  const server = http.createServer((clientReq, clientRes) => {
    const reqStart = Date.now();
    const requestChunks: Buffer[] = [];
    let requestBytes = 0;
    const MAX_LOG_BODY = 50 * 1024 * 1024; // 50MB cap to avoid runaway memory

    clientReq.on("data", (chunk: Buffer) => {
      requestBytes += chunk.length;
      if (requestBytes <= MAX_LOG_BODY) {
        requestChunks.push(chunk);
      }
    });

    const targetPath = clientReq.url || "/";
    const headersOut: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (v == null) continue;
      if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
      headersOut[k] = v as string | string[];
    }
    headersOut["host"] = upstreamHost;
    // Force identity so we can capture the body for logging without inflating gzip.
    headersOut["accept-encoding"] = "identity";

    const upstreamReq = upstreamRequest({
      host: upstreamHost,
      port: upstreamPort,
      method: clientReq.method,
      path: targetPath,
      headers: headersOut,
      agent: upstreamAgent,
    });

    let responseChunks: Buffer[] = [];
    let responseBytes = 0;
    let upstreamRes: http.IncomingMessage | null = null;

    upstreamReq.on("response", (res: http.IncomingMessage) => {
      upstreamRes = res;

      const respHeadersOut: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v == null) continue;
        if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
        respHeadersOut[k] = v as string | string[];
      }
      clientRes.writeHead(res.statusCode || 502, res.statusMessage, respHeadersOut);

      res.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (responseBytes <= MAX_LOG_BODY) {
          responseChunks.push(chunk);
        }
        if (!clientRes.write(chunk)) {
          res.pause();
          clientRes.once("drain", () => res.resume());
        }
      });

      res.on("end", () => {
        clientRes.end();
        finalizeLog();
      });

      res.on("error", () => {
        clientRes.destroy();
        finalizeLog();
      });
    });

    upstreamReq.on("error", (err) => {
      try {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "text/plain" });
        }
        clientRes.end(`claude-trace-v2 proxy upstream error: ${err.message}`);
      } catch {
        // ignore
      }
      finalizeLog(err);
    });

    clientReq.pipe(upstreamReq);

    clientReq.on("close", () => {
      if (!upstreamReq.writableEnded) {
        upstreamReq.destroy();
      }
    });

    let logFinalized = false;
    const finalizeLog = (err?: Error) => {
      if (logFinalized) return;
      logFinalized = true;

      const pathname = (() => {
        try {
          return new URL(targetPath, "http://placeholder").pathname;
        } catch {
          return targetPath;
        }
      })();

      if (!shouldLogPath(pathname, includeAllRequests, logPathMatcher)) return;

      const reqBody = Buffer.concat(requestChunks);
      const reqContentType =
        (clientReq.headers["content-type"] as string | undefined) ?? undefined;
      const respBody = Buffer.concat(responseChunks);
      const respContentType = upstreamRes
        ? (upstreamRes.headers["content-type"] as string | undefined)
        : undefined;

      const protoForLog = upstreamProtocol;
      const portSuffix =
        (protoForLog === "https:" && upstreamPort !== 443) ||
        (protoForLog === "http:" && upstreamPort !== 80)
          ? `:${upstreamPort}`
          : "";
      const fullUrl = `${protoForLog}//${upstreamHost}${portSuffix}${targetPath}`;

      const pair: RawPair = {
        request: {
          timestamp: reqStart / 1000,
          method: clientReq.method || "GET",
          url: fullUrl,
          headers: redactSensitiveHeaders(clientReq.headers),
          body: parseRequestBodyForLog(reqBody, reqContentType),
        },
        response: upstreamRes
          ? {
              timestamp: Date.now() / 1000,
              status_code: upstreamRes.statusCode || 0,
              headers: redactSensitiveHeaders(upstreamRes.headers),
              ...parseResponseBodyForLog(respBody, respContentType),
            }
          : null,
        logged_at: new Date().toISOString(),
        ...(err ? { note: `PROXY_ERROR: ${err.message}` } : {}),
      };

      logger.recordPair(pair);
    };
  });

  // CONNECT method support: claude-code v2 might attempt HTTPS through the proxy
  // for non-Anthropic hosts; we tunnel transparently without logging.
  server.on("connect", (req, clientSocket, head) => {
    const [host, portStr] = (req.url || "").split(":");
    const port = parseInt(portStr || "443", 10);
    const net = require("net") as typeof import("net");
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
