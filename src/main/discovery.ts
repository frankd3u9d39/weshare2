import { BrowserWindow } from 'electron';
import dgram from 'dgram';
import crypto from 'crypto';
import { DeviceManager } from '../services/deviceManager';
import { rememberDiscoveredFingerprint } from './tlsTrust';

const DISCOVERY_PORT = 5774;
const BROADCAST_INTERVAL_MS = 10_000;

// Random id for this running copy of Weshare. Our own broadcast comes back to us, sometimes
// from an address that isn't in our address list (e.g. 127.0.0.1), so replies carry this id
// and we drop any reply that has ours.
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

const isLoopbackAddress = (address: string) => address.startsWith('127.') || address === '::1' || address === '::ffff:127.0.0.1';

export interface DiscoveryHandle {
  stop(): void;
}

export function startUDPDiscovery(options: {
  getServerPort: () => number;
  getFingerprint: () => string;
  getMainWindow: () => BrowserWindow | null;
}): DiscoveryHandle {
  let udpSocket: dgram.Socket | null = null;
  let udpBroadcastInterval: NodeJS.Timeout | null = null;

  function broadcastDiscover() {
    try {
      if (udpSocket) {
        const discoverMsg = Buffer.from('WESHARE_DISCOVER');
        udpSocket.send(discoverMsg, 0, discoverMsg.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
          if (err) {
            console.error('[UDP Discovery] Broadcast failed:', err);
          }
        });
      }
    } catch (err) {
      console.error('[UDP Discovery] Broadcast error:', err);
    }
  }

  try {
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('error', (err: any) => {
      console.error('[UDP Discovery] Socket error:', err);
      try {
        udpSocket?.close();
      } catch (e) {}
      udpSocket = null;
    });

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const messageStr = msg.toString('utf8').trim();

        // 1. If it's a discovery request, reply with our info
        if (messageStr === 'WESHARE_DISCOVER') {
          const dm = DeviceManager.getInstance();
          const localIps = dm.getLocalIPs();

          // Don't reply to ourselves
          if (localIps.includes(rinfo.address) || isLoopbackAddress(rinfo.address)) {
            return;
          }

          // Never include the pairing PIN here: anyone on the LAN can send a
          // discovery packet, so the PIN must be read off the host's screen.
          const responseData = {
            type: 'WESHARE_DEVICE_RESPONSE',
            id: 'desktop-main-' + dm.getDeviceName(),
            name: dm.getDeviceName(),
            port: options.getServerPort(),
            // Public certificate fingerprint (not secret) so other WeShare computers can pin it.
            fingerprint: options.getFingerprint(),
            os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
            instance: INSTANCE_ID
          };

          const responseBuf = Buffer.from(JSON.stringify(responseData));
          udpSocket?.send(responseBuf, 0, responseBuf.length, DISCOVERY_PORT, rinfo.address, (err) => {
            if (err) {
              console.error(`[UDP Discovery] Failed to send response to ${rinfo.address}:`, err);
            }
          });
        }
        // 2. If it's a discovery response, process it
        else if (messageStr.startsWith('{')) {
          const data = JSON.parse(messageStr);
          if (data && data.type === 'WESHARE_DEVICE_RESPONSE') {
            const dm = DeviceManager.getInstance();
            const localIps = dm.getLocalIPs();

            // Skip responses from our own server
            const isOurselves =
              data.instance === INSTANCE_ID ||
              isLoopbackAddress(rinfo.address) ||
              (localIps.includes(rinfo.address) && data.port === options.getServerPort());
            if (!isOurselves) {
              rememberDiscoveredFingerprint(rinfo.address, data.fingerprint);

              // Send the discovered device details to the renderer process
              const discoveredDevice = {
                id: data.id || `desktop-${rinfo.address}-${data.port}`,
                name: data.name,
                ip: rinfo.address,
                port: data.port,
                fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint.toUpperCase() : '',
                os: data.os || 'Windows'
              };

              console.log(`[UDP Discovery] Found ${discoveredDevice.name} at ${rinfo.address}:${data.port}`);
              options.getMainWindow()?.webContents.send('device-discovered', discoveredDevice);
            }
          }
        }
      } catch (err) {
        console.error('[UDP Discovery] Failed to process incoming message:', err);
      }
    });

    udpSocket.bind(DISCOVERY_PORT, () => {
      try {
        udpSocket?.setBroadcast(true);
        console.log(`[UDP Discovery] Socket bound to port ${DISCOVERY_PORT}, broadcast enabled`);

        // Initial broadcast
        broadcastDiscover();

        // Periodic broadcast
        udpBroadcastInterval = setInterval(broadcastDiscover, BROADCAST_INTERVAL_MS);
      } catch (err) {
        console.error('[UDP Discovery] Error configuring socket options after bind:', err);
      }
    });
  } catch (err) {
    console.error('[UDP Discovery] Initialization failed:', err);
  }

  return {
    stop() {
      if (udpBroadcastInterval) {
        clearInterval(udpBroadcastInterval);
        udpBroadcastInterval = null;
      }
      if (udpSocket) {
        try {
          udpSocket.close();
        } catch (e) {}
        udpSocket = null;
      }
    }
  };
}
