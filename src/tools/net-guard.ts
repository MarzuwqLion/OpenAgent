/**
 * A25: browser egress guard (REVIEW-H1 part a, SSRF hard block).
 *
 * The browser may only reach public internet addresses. A destination is
 * blocked when its host is, or resolves to (ANY resolved address), one of:
 *   loopback 127/8, ::1, `localhost`, `*.localhost`
 *   link-local 169.254/16 (cloud metadata 169.254.169.254), fe80::/10
 *   private 10/8, 172.16/12, 192.168/16, CGNAT 100.64/10, unique-local fc00::/7
 *   unspecified 0.0.0.0/8 and ::, broadcast, multicast 224/4 and ff00::/8,
 *   other reserved/special-purpose ranges, and the IPv4-mapped, IPv4-compatible
 *   and NAT64 IPv6 forms of all of the above.
 *
 * Two layers, both enforced on every request (see browser.ts):
 *  1. `context.route` / `context.routeWebSocket` checks each request the page
 *     makes (navigations, iframes, subresources, fetch/XHR, WebSockets) and
 *     aborts blocked ones with a clear reason.
 *  2. Chromium is forced through the local egress proxy below (loopback
 *     included, via Playwright's `<-loopback>` bypass rule). The proxy resolves
 *     DNS itself, vets every address, and connects to the vetted IP. That
 *     covers what the route layer cannot see (redirect hops, workers) and pins
 *     the IP so DNS rebinding between "check" and "connect" is impossible:
 *     Chromium never resolves names for proxied requests.
 *
 * No escape hatch, by design (Lead decision for A25).
 */
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

// ─── Address classification ─────────────────────────────────────────────

const V4_BLOCKED: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified/"this network"'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local/cloud metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF special-purpose'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved/broadcast'],
];

const V6_BLOCKED: Array<[string, number, string]> = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::', 96, 'IPv4-compatible'],
  ['64:ff9b:1::', 48, 'local-use NAT64'],
  ['100::', 64, 'discard-only'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

const v4Lists = V4_BLOCKED.map(([net4, prefix, label]) => {
  const b = new net.BlockList();
  b.addSubnet(net4, prefix, 'ipv4');
  return { b, label };
});
const v6Lists = V6_BLOCKED.map(([net6, prefix, label]) => {
  const b = new net.BlockList();
  b.addSubnet(net6, prefix, 'ipv6');
  return { b, label };
});

/** Expand an IPv6 literal (no brackets/zone) to 8 numeric hextets, or undefined. */
function ipv6Hextets(ip: string): number[] | undefined {
  let s = ip;
  let tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4?.[1]) {
    const o = v4[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return undefined;
    tail = [((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0)];
    s = s.slice(0, -v4[1].length);
    if (!s.endsWith('::') && s.endsWith(':')) s = s.slice(0, -1);
  }
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  let groups: number[];
  if (s.includes('::')) {
    const [a = '', b = ''] = s.split('::');
    const head = parse(a);
    const back = parse(b);
    const fill = 8 - head.length - back.length - tail.length;
    if (fill < 0) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...back, ...tail];
  } else {
    groups = [...parse(s), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

function hextetsToV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** A25: why an IP literal is blocked, or undefined if it is a public address. */
export function blockedAddressReason(ipRaw: string): string | undefined {
  let ip = ipRaw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const family = net.isIP(ip);
  if (family === 4) {
    for (const { b, label } of v4Lists) if (b.check(ip, 'ipv4')) return `${label} address ${ip}`;
    return undefined;
  }
  if (family === 6) {
    const h = ipv6Hextets(ip.toLowerCase());
    if (!h) return `unparsable IPv6 address ${ip}`;
    const [h0, h1, h2, h3, h4, h5, h6 = 0, h7 = 0] = h;
    // IPv4-mapped ::ffff:a.b.c.d, SIIT IPv4-translated ::ffff:0:a.b.c.d and
    // NAT64 64:ff9b::a.b.c.d carry an IPv4 destination in the low 32 bits.
    const mapped = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff;
    const siit = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0;
    const nat64 = h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
    if (mapped || siit || nat64) {
      const inner = blockedAddressReason(hextetsToV4(h6, h7));
      return inner ? `${inner} (as ${ip})` : undefined;
    }
    // REVIEW-L12: transition forms with an embedded IPv4, re-checked as IPv4.
    // 6to4 2002:AABB:CCDD::/48 embeds AABB:CCDD.
    if (h0 === 0x2002) {
      const inner = blockedAddressReason(hextetsToV4(h1 ?? 0, h2 ?? 0));
      if (inner) return `${inner} (6to4 ${ip})`;
    }
    // Teredo 2001:0000::/32 embeds the server IPv4 (bits 32-63) and the
    // client IPv4 XOR-obfuscated in the low 32 bits.
    if (h0 === 0x2001 && h1 === 0) {
      const server = blockedAddressReason(hextetsToV4(h2 ?? 0, h3 ?? 0));
      if (server) return `${server} (Teredo server in ${ip})`;
      const client = blockedAddressReason(hextetsToV4(h6 ^ 0xffff, h7 ^ 0xffff));
      if (client) return `${client} (Teredo client in ${ip})`;
    }
    const canonical = h.map((g) => g.toString(16)).join(':');
    for (const { b, label } of v6Lists) if (b.check(canonical, 'ipv6')) return `${label} address ${ip}`;
    return undefined;
  }
  return `not an IP address: ${ip}`;
}

/** Hostname as Chromium will use it: lowercase, no brackets, no trailing dots. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** Blocked without a DNS lookup (IP literal or a reserved name), or undefined. */
export function blockedHostnameReason(hostRaw: string): string | undefined {
  const host = normalizeHost(hostRaw);
  if (host === '') return 'empty host';
  if (net.isIP(host)) return blockedAddressReason(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return `loopback name ${host}`;
  return undefined;
}

// ─── DNS with a short TTL cache ─────────────────────────────────────────

export type Destination =
  | { ok: true; host: string; addresses: Array<{ address: string; family: 4 | 6 }> }
  | { ok: false; host: string; reason: string };

const DNS_TTL_MS = 30_000;
const DNS_CACHE_MAX = 500;
const dnsCache = new Map<string, { at: number; value: Destination }>();

type LookupAll = (host: string) => Promise<Array<{ address: string; family: number }>>;
let lookupAll: LookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Test seam: replace the resolver (and clear the cache). Not an escape hatch: it cannot unblock a range. */
export function setResolverForTests(fn?: LookupAll): void {
  lookupAll = fn ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
  dnsCache.clear();
}

/**
 * A25: vet a host. Blocked if it is a blocked literal/name or if ANY address
 * it resolves to is blocked. On success returns the address to connect to.
 */
export async function resolveDestination(hostRaw: string): Promise<Destination> {
  const host = normalizeHost(hostRaw);
  const literal = blockedHostnameReason(host);
  if (literal) return { ok: false, host, reason: literal };
  const fam = net.isIP(host);
  if (fam === 4 || fam === 6) return { ok: true, host, addresses: [{ address: host, family: fam }] };

  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.value;

  let value: Destination;
  try {
    const addrs = await lookupAll(host);
    if (addrs.length === 0) {
      value = { ok: false, host, reason: `${host} did not resolve` };
    } else {
      const bad = addrs.map((a) => blockedAddressReason(a.address)).find((r) => r !== undefined);
      // IPv4 first: containers often have no IPv6 route. All of them are vetted.
      const addresses = addrs
        .map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }) as const)
        .sort((a, b) => a.family - b.family);
      value = bad ? { ok: false, host, reason: `${host} resolves to a ${bad}` } : { ok: true, host, addresses };
    }
  } catch (err) {
    value = { ok: false, host, reason: `${host} did not resolve (${(err as NodeJS.ErrnoException).code ?? 'DNS error'})` };
  }
  dnsCache.delete(host);
  dnsCache.set(host, { at: Date.now(), value });
  while (dnsCache.size > DNS_CACHE_MAX) {
    const oldest = dnsCache.keys().next().value;
    if (oldest === undefined) break;
    dnsCache.delete(oldest);
  }
  return value;
}

/** Schemes the page may load without a network request of its own. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/**
 * A25: vet a URL the browser is about to request. http(s)/ws(s) are vetted by
 * host; data:/blob:/about: carry no network destination; anything else is refused.
 */
export async function checkRequestUrl(raw: string): Promise<{ ok: true } | { ok: false; host: string; reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: '', reason: 'invalid URL' };
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return { ok: true };
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return { ok: false, host: url.host, reason: `scheme ${url.protocol} is not allowed` };
  }
  const d = await resolveDestination(url.hostname);
  return d.ok ? { ok: true } : { ok: false, host: d.host, reason: d.reason };
}

// ─── Block log (so tools can explain what happened) ─────────────────────

export interface BlockEvent {
  seq: number;
  at: number;
  layer: 'route' | 'websocket' | 'proxy';
  host: string;
  reason: string;
  url: string;
}

const BLOCK_LOG_MAX = 50;
const blockLog: BlockEvent[] = [];
let blockSeq = 0;

export function recordBlock(e: Omit<BlockEvent, 'seq' | 'at'>): void {
  blockSeq++;
  blockLog.push({ ...e, seq: blockSeq, at: Date.now() });
  if (blockLog.length > BLOCK_LOG_MAX) blockLog.shift();
  console.warn(`[browser] A25 blocked ${e.layer} request to ${e.host}: ${e.reason}`);
}

/** Current block sequence number; pass it to blocksSince() later. */
export function currentBlockSeq(): number {
  return blockSeq;
}

export function blocksSince(seq: number): BlockEvent[] {
  return blockLog.filter((e) => e.seq > seq);
}

// ─── Pinning egress proxy ───────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
/** Idle timeout for a forwarded plain-HTTP exchange. */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;
/** REVIEW-L12: idle timeout for an established CONNECT tunnel (HTTPS, WebSockets). */
const TUNNEL_IDLE_TIMEOUT_MS = 300_000;

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const extra = String(headers.connection ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || extra.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Split a CONNECT authority ("host:port" or "[v6]:port"). */
function parseAuthority(raw: string | undefined): { host: string; port: number } | undefined {
  if (!raw) return undefined;
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(raw) ?? /^([^:]+):(\d+)$/.exec(raw);
  if (!m?.[1] || !m[2]) return undefined;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: m[1], port };
}

/**
 * A25: a DNS lookup that only ever answers with the vetted addresses, so the
 * socket connects to exactly what was checked (no second resolution, no
 * rebinding). Works with autoSelectFamily (happy eyeballs) over those addresses.
 */
function pinnedLookup(addresses: Array<{ address: string; family: 4 | 6 }>): net.LookupFunction {
  return (_hostname, options, callback) => {
    const first = addresses[0];
    if (!first) {
      callback(Object.assign(new Error('no vetted address'), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  };
}

const BLOCK_BODY = (host: string, reason: string) =>
  `blocked: private/metadata address. OpenAgent's browser may not reach ${host} (${reason}).\n`;

export interface EgressProxy {
  /** "http://127.0.0.1:<port>" for Chromium's proxy.server. */
  url: string;
  /** True once the server stopped listening; callers then start a new proxy. */
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * A25: start the in-process pinning proxy on 127.0.0.1 (random port). Plain
 * HTTP is forwarded to the vetted IP with the original Host header; CONNECT
 * (HTTPS and WebSockets) is tunnelled to the vetted IP, so TLS stays
 * end-to-end between Chromium and the site. Anything blocked gets a 403.
 */
export async function startEgressProxy(): Promise<EgressProxy> {
  const server = http.createServer((req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('proxy: absolute URL required\n');
        return;
      }
      if (url.protocol !== 'http:') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('proxy: only http:// is forwarded; use CONNECT\n');
        return;
      }
      const d = await resolveDestination(url.hostname);
      if (!d.ok) {
        recordBlock({ layer: 'proxy', host: d.host, reason: d.reason, url: url.toString() });
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(BLOCK_BODY(d.host, d.reason));
        return;
      }
      const upstreamOptions: http.RequestOptions = {
        host: d.host,
        lookup: pinnedLookup(d.addresses),
        port: url.port ? Number(url.port) : 80,
        path: `${url.pathname}${url.search}`,
        headers: stripHopByHop(req.headers),
        setHost: false,
        agent: false,
        timeout: UPSTREAM_IDLE_TIMEOUT_MS,
      };
      if (req.method) upstreamOptions.method = req.method;
      const upstream = http.request(upstreamOptions, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage ?? '', stripHopByHop(upRes.headers));
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('proxy: upstream error\n');
        else res.destroy();
      });
      req.pipe(upstream);
      req.on('error', () => upstream.destroy());
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });

  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => undefined);
    void (async () => {
      const target = parseAuthority(req.url);
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const d = await resolveDestination(target.host);
      if (!d.ok) {
        recordBlock({ layer: 'proxy', host: d.host, reason: d.reason, url: `${req.url ?? ''}` });
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' + BLOCK_BODY(d.host, d.reason));
        return;
      }
      let established = false;
      const upstream = net.connect({
        host: d.host,
        port: target.port,
        lookup: pinnedLookup(d.addresses),
        autoSelectFamily: true,
      });
      upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('connect timeout')));
      upstream.once('connect', () => {
        established = true;
        // REVIEW-L12: established tunnels close after a period of silence in both directions.
        upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => {
          upstream.destroy();
          client.destroy();
        });
        client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
        client.on('timeout', () => {
          upstream.destroy();
          client.destroy();
        });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => {
        if (!established && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        else client.destroy();
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    })().catch(() => client.destroy());
  });

  // Non-CONNECT upgrades are not expected from Chromium; fail closed.
  server.on('upgrade', (_req: http.IncomingMessage, socket: net.Socket) => socket.destroy());
  server.on('clientError', (_err: Error, socket: net.Socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  // REVIEW-L12: an accept error (e.g. EMFILE) after listen must not crash the process.
  let closed = false;
  server.on('error', (err: Error) => {
    console.error(`[browser] A25 egress proxy error: ${err.message}`);
  });
  server.on('close', () => {
    closed = true;
  });
  server.unref();
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    isClosed: () => closed || !server.listening,
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
