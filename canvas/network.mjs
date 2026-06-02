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
import fs from 'node:fs';
import path from 'node:path';

// Protocol identifiers. Versioned so we can iterate on the wire format
// without breaking peers that still speak the old one.
export const FEED_PROTOCOL = '/liquidos/share/feed/1.0.0';
export const BUNDLE_PROTOCOL = '/liquidos/share/bundle/1.0.0';

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
            dht: kadDHT({ clientMode: false })
        }
    });
    return node;
};

// Register the share protocols on a running node. sharePath is the
// directory where the local feed and bundle blobs live (typically
// <workspace>/.share/). The protocols are intentionally minimal:
//
//   Feed protocol: client opens stream, server writes the bytes of
//   feed.json and closes. No request body — the feed is a per-peer
//   singleton.
//
//   Bundle protocol: client writes "<hash>\n" on the stream and
//   closes its write side. Server reads the hash, looks up
//   <sharePath>/bundles/<hash>.tar, and writes the bundle bytes
//   followed by close. If the hash is unknown, the server writes
//   nothing and closes — the client sees EOF immediately, which is
//   "not found." Integrity is the receiver's responsibility: re-hash
//   the unpacked bundle and verify against the requested hash.
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

export const SHARING_STATE_FILE = 'sharing.json';

// Default: sharing on. The state file is opt-out, so a fresh workspace
// that has published bundles serves them immediately without any
// explicit "enable sharing" step.
export const isSharingEnabled = (sharePath) => {
    try {
        const file = path.join(sharePath, SHARING_STATE_FILE);
        if (!fs.existsSync(file)) return true;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed.enabled !== false;
    } catch {
        return true;
    }
};

export const setSharingEnabled = (sharePath, enabled) => {
    fs.mkdirSync(sharePath, { recursive: true });
    fs.writeFileSync(
        path.join(sharePath, SHARING_STATE_FILE),
        JSON.stringify({ enabled: !!enabled }, null, 2) + '\n'
    );
};

export const registerShareProtocols = (node, sharePath) => {
    const feedPath = path.join(sharePath, 'feed.json');
    const bundleDir = path.join(sharePath, 'bundles');

    const readBytes = (file) => {
        try { return fs.existsSync(file) ? fs.readFileSync(file) : null; }
        catch { return null; }
    };

    // The sharing flag is checked on each request rather than at
    // registration time — the toggle has immediate effect without
    // restarting the harness.
    const empty = () => Buffer.from('{"feedVersion":1,"bundles":[]}\n');

    node.handle(FEED_PROTOCOL, async (stream) => {
        try {
            const bytes = isSharingEnabled(sharePath)
                ? (readBytes(feedPath) || empty())
                : empty();
            await sendAll(stream, bytes);
            await stream.close();
        } catch {
            try { await stream.close(); } catch {}
        }
    });

    node.handle(BUNDLE_PROTOCOL, async (stream) => {
        try {
            // Read until client closes its write side. The client
            // sends "<hash>\n" and nothing else.
            const req = (await collect(stream)).toString('utf8').trim();
            // When sharing is off, treat every request as "not found"
            // — same code path as an unknown hash. Same empty-body
            // signal, no leak about what we do have.
            if (!isSharingEnabled(sharePath)) {
                await stream.close();
                return;
            }
            // Basic sanitization: only serve our own bundle blobs.
            // Hash shape is "sha256-<hex>" — no slashes, no dots.
            if (!/^sha256-[0-9a-f]{64}$/.test(req)) {
                await stream.close();
                return;
            }
            const file = path.join(bundleDir, req + '.tar');
            const data = readBytes(file);
            if (data) await sendAll(stream, data);
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

export const fetchFeed = async (node, target) =>
    dialAndCollect(node, target, FEED_PROTOCOL, null);

export const fetchBundle = async (node, target, hash) =>
    dialAndCollect(node, target, BUNDLE_PROTOCOL, Buffer.from(hash + '\n', 'utf8'));

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
