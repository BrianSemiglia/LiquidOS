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
import fs from 'node:fs';
import path from 'node:path';

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
