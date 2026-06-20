//
// network.mjs — libp2p node lifecycle for LiquidOS.
//
// Each workspace gets a stable peer identity (Ed25519 keypair, stored
// at `<workspace>/.network/identity.bin`) and runs a libp2p node that
// joins the public DHT via well-known bootstrap peers. The pubkey IS
// the workspace's network identity — same shape as IPFS peer IDs.
//
// This module deliberately does NOT speak any LiquidOS-specific
// protocol yet. It just establishes connectivity. Bundle exchange,
// feed publish, content discovery layer on top in later commits.
//

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import fs from 'node:fs';
import path from 'node:path';

// Protocol identifier. Versioned so we can iterate on the wire format
// without breaking peers that still speak the old one. Returns the
// peer's feed.json — a list of their published bundles with each
// bundle's requirements text inlined.
const FEED_PROTOCOL = '/liquidos/share/feed/1.0.0';

// Public IPFS bootstrap peers — used to enter the DHT. These same peers
// bootstrap IPFS, Filecoin, and other libp2p networks; piggybacking on
// them is the standard practice. If we ever want isolation, swap in our
// own. Static IPs are intentionally avoided because the maintainers
// rotate hosts; dnsaddr lets them update entries without breaking us.
const BOOTSTRAP_PEERS = [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
];

const loadOrCreateIdentity = async (identityPath) => {
    if (fs.existsSync(identityPath)) {
        const bytes = fs.readFileSync(identityPath);
        return privateKeyFromProtobuf(bytes);
    }
    const privateKey = await generateKeyPair('Ed25519');
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    // Write to a temp path then rename to avoid leaving a half-written
    // identity if the process is killed mid-write.
    const tempPath = identityPath + '.tmp';
    fs.writeFileSync(tempPath, privateKeyToProtobuf(privateKey));
    fs.renameSync(tempPath, identityPath);
    return privateKey;
};

export const createNetworkNode = async ({ identityPath }) => {
    const privateKey = await loadOrCreateIdentity(identityPath);
    const node = await createLibp2p({
        privateKey,
        addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        peerDiscovery: [bootstrap({ list: BOOTSTRAP_PEERS })],
        services: {
            identify: identify(),
            // kad-dht requires a ping service to probe peer liveness
            // during routing-table maintenance.
            ping: ping(),
            // Client mode: we query the DHT to announce ourselves and find
            // other LiquidOS peers, but we do NOT serve as a routing node for
            // the public IPFS network. Server mode (clientMode:false) makes a
            // desktop app answer routing/provider queries from thousands of
            // strangers — sustained CPU for no benefit to a sharing app.
            dht: kadDHT({ clientMode: true })
        }
    });
    return node;
};

// Register the share protocol on a running node. sharePath is the
// directory where the local feed lives (typically <workspace>/.share/).
//
//   Feed protocol: client opens stream, server writes the bytes of
//   feed.json and closes. No request body. The feed inlines every
//   shared bundle's requirements text — there's no separate fetch.
//
// Send data through the libp2p v3 MessageStream API, splitting large
// payloads at the muxer's max-message boundary and waiting for the
// drain event when send() reports back-pressure. The send() call
// returns false when the underlying transport's write buffer is full,
// and the next call will throw if we don't wait for the drain event
// first.
const sendAll = async (stream, bytes) => {
    if (!bytes || bytes.length === 0) return;
    // Yamux default max message size is ~262144 bytes (256KB). Stay
    // safely below that.
    const CHUNK = 64 * 1024;
    let offset = 0;
    while (offset < bytes.length) {
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
        const ok = stream.send(new Uint8Array(slice));
        offset += slice.length;
        if (!ok) {
            await new Promise((resolve, reject) => {
                const onDrain = () => { cleanup(); resolve(); };
                const onClose = () => { cleanup(); reject(new Error('stream closed before drain')); };
                const cleanup = () => {
                    stream.removeEventListener('drain', onDrain);
                    stream.removeEventListener('close', onClose);
                };
                stream.addEventListener('drain', onDrain);
                stream.addEventListener('close', onClose);
            });
        }
    }
};

// Read every byte the peer sends until they half-close their write
// side (or the stream closes). Returns one Buffer.
const collect = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk.subarray ? chunk.subarray() : chunk));
    }
    return Buffer.concat(chunks);
};

// Per-instance sharing: a canvas opts in via <workspace>/<canvas>/share.json
// ({ "shared": true }); its components inherit unless their own share.json
// explicitly opts out ({ "shared": false }). No workspace-level master toggle.
const readShareFlag = (file) => {
    try {
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof parsed.shared === 'boolean' ? parsed.shared : null;
    } catch { return null; }
};

const isCanvasShared = (workspacePath, canvasName) =>
    readShareFlag(path.join(workspacePath, canvasName, 'share.json')) === true;

// Canvas folders are the non-dotted direct children of the workspace that hold
// an index.json (mirrors canvas/files.js availableCanvases).
const canvasNames = (workspacePath) => {
    try {
        return fs.readdirSync(workspacePath, { withFileTypes: true })
            .filter(entry =>
                entry.isDirectory() &&
                !entry.name.startsWith('.') &&
                fs.existsSync(path.join(workspacePath, entry.name, 'index.json')))
            .map(entry => entry.name);
    } catch { return []; }
};

// True when any canvas in the workspace has opted into sharing. This is the
// opt-in signal the harness uses to decide whether networking should run at
// all: nothing shared ⇒ no node ⇒ no public-DHT CPU.
export const anyCanvasShared = (workspacePath) =>
    canvasNames(workspacePath).some(name => isCanvasShared(workspacePath, name));

const isComponentShared = (workspacePath, canvasName, componentName) => {
    if (!isCanvasShared(workspacePath, canvasName)) return false;
    const file = path.join(workspacePath, canvasName, 'components', componentName, 'share.json');
    return readShareFlag(file) !== false;
};

// Filter the feed to only the bundles (and components within them) that
// the user has opted in. Returns a JSON buffer with the same shape.
const filteredFeedBytes = (workspacePath, feedBytes) => {
    let parsed;
    try { parsed = JSON.parse(feedBytes.toString('utf8')); }
    catch { return Buffer.from('{"feedVersion":1,"bundles":[]}\n'); }
    const bundles = Array.isArray(parsed.bundles) ? parsed.bundles : [];
    const kept = bundles
        .filter(bundle => bundle && typeof bundle.name === 'string' && isCanvasShared(workspacePath, bundle.name))
        .map(bundle => ({
            ...bundle,
            components: Array.isArray(bundle.components)
                ? bundle.components.filter(component =>
                    component && typeof component.name === 'string'
                    && isComponentShared(workspacePath, bundle.name, component.name))
                : []
        }));
    return Buffer.from(JSON.stringify({ ...parsed, bundles: kept }, null, 2) + '\n');
};

export const registerShareProtocols = (node, sharePath, workspacePath) => {
    const feedPath = path.join(sharePath, 'feed.json');

    const readBytes = (file) => {
        try { return fs.existsSync(file) ? fs.readFileSync(file) : null; }
        catch { return null; }
    };

    // Share state is read on each request so toggles take immediate effect
    // without restarting the harness.
    const empty = () => Buffer.from('{"feedVersion":1,"bundles":[]}\n');

    node.handle(FEED_PROTOCOL, async (stream) => {
        try {
            const raw = readBytes(feedPath);
            const bytes = raw ? filteredFeedBytes(workspacePath, raw) : empty();
            await sendAll(stream, bytes);
            await stream.close();
        } catch {
            try { await stream.close(); } catch {}
        }
    });
};

// Open a stream to a peer (given either a peerId string or a full
// multiaddr) and collect all bytes the peer sends.
const dialAndCollect = async (node, target, protocol, requestBytes) => {
    let dialTarget;
    if (target.startsWith('/')) {
        dialTarget = multiaddr(target);
    } else {
        dialTarget = peerIdFromString(target);
    }
    const stream = await node.dialProtocol(dialTarget, protocol);
    try {
        // Start collecting IMMEDIATELY (before we send or close), so we
        // register the message + remoteCloseWrite listeners before the
        // server's quick response can arrive and fire those events.
        // libp2p's async iterator implementation only buffers messages
        // received AFTER the iterator's listeners are attached.
        const collectPromise = collect(stream);
        if (requestBytes && requestBytes.length > 0) {
            await sendAll(stream, requestBytes);
        }
        // Close our write side so the server knows we're done sending
        // and can start replying.
        await stream.close();
        return await collectPromise;
    } catch (error) {
        try { await stream.close(); } catch {}
        throw error;
    }
};

const fetchFeed = async (node, target) =>
    dialAndCollect(node, target, FEED_PROTOCOL, null);

export const statusOf = (node) => {
    if (!node) return { running: false };
    return {
        running: true,
        peerId: node.peerId.toString(),
        multiaddrs: node.getMultiaddrs().map(m => m.toString()),
        connections: node.getConnections().length,
        peers: node.getPeers().map(p => p.toString())
    };
};

export const stopNetworkNode = async (node) => {
    if (!node) return;
    try { await node.stop(); }
    catch { /* best-effort shutdown */ }
};

// --- Peer feed cache -------------------------------------------------------
//
// Whenever libp2p tells us a new peer is connected (DHT introduction,
// direct dial, anything), we try to fetchFeed against them. Peers that
// speak our protocol respond with their feed.json; everyone else fails
// silently. The successful responses populate an in-memory cache; the
// GET /share endpoint reads only from that cache so query text never
// leaves the local process (privacy by construction).
//
// We also re-poll known LiquidOS peers on a low-frequency timer so a
// peer's share-toggle eventually shows up in our search results without
// them having to reconnect. Browse is an occasional, user-initiated
// action — there's no value in chasing fresh peer state on a tight
// clock. A few hours of staleness is fine.
const PEER_FEED_REPOLL_INTERVAL_MS = 4 * 60 * 60_000;       // 4 h
const PEER_FEED_FETCH_TIMEOUT_MS = 5_000;

// DHT rendezvous: every LiquidOS peer announces itself as a provider
// of a fixed CID derived from a well-known string. Other peers query
// the DHT for that CID and get the list of LiquidOS peers currently
// in the network. The CID is content-addressed so any peer can derive
// it without coordination.
const RENDEZVOUS_KEY = '/liquidos/peers/v1';
const PROVIDE_REANNOUNCE_INTERVAL_MS = 12 * 60 * 60 * 1000;  // 12h (DHT records last ~24h)
const DHT_DISCOVERY_INTERVAL_MS = 4 * 60 * 60_000;          // 4h — see PEER_FEED_REPOLL_INTERVAL_MS rationale
const DHT_DISCOVERY_TIMEOUT_MS = 10_000;

let cachedRendezvousCid = null;
const rendezvousCid = async () => {
    if (!cachedRendezvousCid) {
        const hash = await sha256.digest(new TextEncoder().encode(RENDEZVOUS_KEY));
        cachedRendezvousCid = CID.createV1(raw.code, hash);
    }
    return cachedRendezvousCid;
};

// Set up the peer-feed cache + discovery loop. Returned object exposes:
//   - cache: Map<peerIdString, { peerId, multiaddrs, feed, refreshedAt }>
//   - stop(): tear down timers (server shutdown)
export const startPeerFeedCache = async (node, workspacePath) => {
    const cache = new Map();
    const ourPeerId = node.peerId.toString();
    // Peers we've successfully fetched a feed from at least once.
    // Re-polled on the timer; non-LiquidOS peers stay out so we don't
    // hammer random DHT neighbors that already rejected the protocol.
    const knownPeers = new Set();

    const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); },
                     error => { clearTimeout(timer); reject(error); });
    });

    const tryFetchFromPeer = async (peerId) => {
        const peerIdString = String(peerId);
        if (peerIdString === ourPeerId) return;
        try {
            const bytes = await withTimeout(fetchFeed(node, peerIdString), PEER_FEED_FETCH_TIMEOUT_MS);
            if (!bytes || bytes.length === 0) return;
            const feed = JSON.parse(bytes.toString('utf8'));
            cache.set(peerIdString, {
                peerId: peerIdString,
                multiaddrs: [],
                feed: feed && typeof feed === 'object' ? feed : { bundles: [] },
                refreshedAt: new Date().toISOString()
            });
            knownPeers.add(peerIdString);
        } catch {
            // Peer doesn't speak the protocol, is offline, or timed out.
            // Silent — non-LiquidOS peers in the DHT are the common case.
        }
    };

    // Hook every new peer connection. libp2p emits 'peer:connect' when
    // a new connection is established to a peer; the dial we do for the
    // /network/dial endpoint also fires this.
    node.addEventListener('peer:connect', (event) => {
        const peerId = event.detail;
        if (!peerId) return;
        tryFetchFromPeer(peerId);
    });

    // Also try every peer that's already connected at startup, in case
    // the libp2p node had connections (via bootstrap) before we wired
    // the listener up.
    for (const conn of node.getConnections()) {
        tryFetchFromPeer(conn.remotePeer);
    }

    // Periodic re-poll. Keeps cached feeds fresh after a peer toggles
    // share on/off. Per-peer fetches run in parallel — one slow peer
    // can't block the others (each has its own
    // PEER_FEED_FETCH_TIMEOUT_MS budget).
    const refresh = async () => {
        await Promise.all(Array.from(knownPeers, tryFetchFromPeer));
    };
    const timer = setInterval(refresh, PEER_FEED_REPOLL_INTERVAL_MS);
    timer.unref && timer.unref();

    // DHT rendezvous. Tell the DHT we provide RENDEZVOUS_KEY so other
    // LiquidOS peers can find us, and periodically query for everyone
    // else providing it. peer:connect catches peers we happen to dial
    // or get dialed by; the DHT lookup is how strangers across the
    // wide network find each other without prior introduction.
    const cid = await rendezvousCid();
    const announce = async () => {
        try { await node.contentRouting.provide(cid); }
        catch { /* DHT may still be bootstrapping; retry on next interval */ }
    };
    // First announce kicks off on a short delay so the DHT has a chance
    // to settle a routing table from the bootstrap peers.
    const initialAnnounceTimer = setTimeout(announce, 5_000);
    initialAnnounceTimer.unref && initialAnnounceTimer.unref();
    const provideTimer = setInterval(announce, PROVIDE_REANNOUNCE_INTERVAL_MS);
    provideTimer.unref && provideTimer.unref();

    const discover = async () => {
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), DHT_DISCOVERY_TIMEOUT_MS);
        try {
            for await (const provider of node.contentRouting.findProviders(cid, { signal: ac.signal })) {
                if (!provider || !provider.id) continue;
                tryFetchFromPeer(provider.id);
            }
        } catch { /* aborted, no providers, or DHT not ready — fine */ }
        finally { clearTimeout(timeout); }
    };
    // Same staggered start; first sweep is slightly delayed so we don't
    // race the bootstrap handshake.
    const initialDiscoverTimer = setTimeout(discover, 8_000);
    initialDiscoverTimer.unref && initialDiscoverTimer.unref();
    const discoverTimer = setInterval(discover, DHT_DISCOVERY_INTERVAL_MS);
    discoverTimer.unref && discoverTimer.unref();

    return {
        cache,
        stop: () => {
            clearInterval(timer);
            clearTimeout(initialAnnounceTimer);
            clearInterval(provideTimer);
            clearTimeout(initialDiscoverTimer);
            clearInterval(discoverTimer);
        }
    };
};

// --- Network manager -------------------------------------------------------
//
// Owns the whole network lifecycle for a workspace: the libp2p node, the peer
// feed cache, the start latch, and the opt-in/lazy-start policy. The harness
// holds one of these and never touches the node directly — so "when does the
// network run" lives here, with sharing, not in the HTTP server.
//
// The rule: the node runs only when it's actually needed. shouldAutoStart()
// is true for a workspace that already shares something (so peers can reach
// it); otherwise the node stays down until ensure() is called by a networking
// action (browse, dial, share-on, install). Pure status reads call status(),
// never ensure(), so an idle non-sharing workspace never joins the DHT.
export const createNetworkManager = ({ workspacePath, log = console.log, logError = console.error }) => {
    let node = null;
    let feed = null;
    let starting = null;

    const start = async () => {
        try {
            node = await createNetworkNode({
                identityPath: path.join(workspacePath, '.network', 'identity.bin')
            });
            registerShareProtocols(node, path.join(workspacePath, '.share'), workspacePath);
            feed = await startPeerFeedCache(node, workspacePath);
            log('Network: peer ID', node.peerId.toString());
            for (const addr of node.getMultiaddrs()) {
                log('Network: listening on', addr.toString());
            }
        } catch (error) {
            logError('Network: failed to start', error?.message || error);
            node = null;
            feed = null;
        }
    };

    return {
        // Start once, on first demand. Idempotent and concurrency-safe:
        // overlapping callers (a share toggle racing a browse) share one start;
        // a failed start clears the latch so the next action retries.
        ensure() {
            if (node) return Promise.resolve(node);
            if (!starting) starting = start().finally(() => { starting = null; });
            return starting.then(() => node);
        },
        // Read-only — must never start the node.
        status() {
            return statusOf(node);
        },
        // Opt-in policy: should the node come up at boot for this workspace?
        shouldAutoStart() {
            return anyCanvasShared(workspacePath);
        },
        // The per-peer feed cache, or null when the node isn't running.
        peerFeed() {
            return feed;
        },
        // The live node, or null when not running.
        node() {
            return node;
        },
        async stop() {
            try { feed?.stop?.(); } catch { /* best-effort */ }
            feed = null;
            const current = node;
            node = null;
            await stopNetworkNode(current);
        }
    };
};
