// Every URL this package fetches after the initial SEP-1 request comes from
// content an anchor controls (its own stellar.toml). A misbehaving or
// compromised anchor can point WEB_AUTH_ENDPOINT / ANCHOR_QUOTE_SERVER /
// KYC_SERVER / DIRECT_PAYMENT_SERVER at an internal address — the cloud
// metadata endpoint, localhost, an RFC1918 host — and this probe would fetch
// it on the anchor's behalf. isSafeUrl() is the one gate all of those URLs
// pass through before being dereferenced.
//
// This is a hostname/IP-literal check only. It does NOT close DNS rebinding
// (a hostname that resolves to a public IP at check-time and a private one at
// connect-time) — that needs a connect-time hook into the fetch dispatcher,
// a materially bigger change. Tracked as a follow-up, not silently closed.

/** IPv4 octet ranges considered internal/non-routable for this purpose. */
function isDisallowedIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // "this network"
  return false;
}

function isDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 [] brackets
  if (host === "localhost") return true;
  if (isDisallowedIPv4(host)) return true;
  // IPv6 loopback / link-local / unique-local, and IPv4-mapped forms.
  if (host === "::1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && isDisallowedIPv4(mapped[1])) return true;
  return false;
}

/** True only for `https://` URLs whose hostname is not a known-internal/local
 *  address. Used to gate every fetch of anchor-toml-derived content. */
export function isSafeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return !isDisallowedHost(url.hostname);
}
