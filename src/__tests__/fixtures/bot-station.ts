import { generateKeyPairSync, sign } from 'node:crypto';
import type { FetchLike } from '../../remote/client';

/** Real Ed25519 ingress fixture; tests never bypass the Bot dispatch pin guard. */
export function botStationFixture(canonical: string) {
  const keys = generateKeyPairSync('ed25519');
  const pin = { instanceId: '1'.repeat(32), publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
  const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
    capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'bot.phone.binding.v2'] };
  const wrap = (transport: FetchLike, publicPing = false): FetchLike => async (url, init) => {
    const now = Date.now();
    if (url === `${canonical}/ingress/manifest`) {
      const body = { version: 1, hub_instance_id: pin.instanceId, identity_public_key: pin.publicKey, canonical_url: canonical,
        revision: 1, issued_at: now, expires_at: now + 86_400_000, endpoints: [{ id: 'canonical', url: canonical, priority: 100 }] };
      const bytes = Buffer.from(JSON.stringify(body));
      return reply({ ...body, signed_payload: bytes.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') });
    }
    if (url.startsWith(`${canonical}/ingress/identity?`)) {
      const nonce = new URL(url).searchParams.get('nonce');
      const body = { version: 1, hub_instance_id: pin.instanceId, nonce, issued_at: now, expires_at: now + 30_000 };
      return reply({ ...body, signature: sign(null, Buffer.from(`salcara-ingress-proof-v1\n${pin.instanceId}\n${nonce}\n${body.issued_at}\n${body.expires_at}`), keys.privateKey).toString('base64') });
    }
    if (publicPing && url.endsWith('/ping')) return reply(discovery);
    return transport(url, init);
  };
  return { pin, discovery, wrap };
}
