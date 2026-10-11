import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

export interface NetworkPolicy { allowHosts?: string[]; }
export function loopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}
const blocked = new BlockList();
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addAddress('100.100.100.200', 'ipv4');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addAddress('::', 'ipv6');
function forbidden(address: string): boolean {
  const kind = isIP(address);
  return kind !== 0 && blocked.check(address, kind === 6 ? 'ipv6' : 'ipv4');
}
export async function assertTarget(raw: string, policy: NetworkPolicy = {}): Promise<void> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) targets without URL credentials are allowed.');
  if (forbidden(host)) throw new Error('Metadata and link-local targets are not allowed.');
  const allowed = policy.allowHosts?.some(item => item.toLowerCase() === host);
  if (!loopback(host) && !allowed) throw new Error('Target is not allowed. Use loopback or explicitly configure allowHosts.');
  // The runner has no DNS-pinning hook. Do not accept allowlisted DNS names:
  // a second resolution at connect time could rebind them to metadata hosts.
  if (allowed && !loopback(host) && !isIP(host)) throw new Error('Remote allowHosts entries must be IP literals; DNS targets require a transport with DNS pinning.');
  const addresses = isIP(host) ? [{address:host}] : await lookup(host, {all:true});
  if (!addresses.length || addresses.some(item => forbidden(item.address) || (!allowed && !loopback(item.address)))) throw new Error('Target resolves to a disallowed address.');
}
