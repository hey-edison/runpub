import { createHash } from 'node:crypto';

const DNS_LABEL_LIMIT = 63;
// Keep 128 bits when a readable label has to be truncated. The database-backed
// edge also enforces a unique hostname, but this makes accidental collisions
// infeasible even before a reservation is written.
const HASH_LENGTH = 32;

/**
 * Convert a user supplied name to a valid, lowercase DNS label fragment.
 */
export function sanitizeDnsLabel(value, fallback = 'service') {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized || fallback;
}

export function slugifyDnsLabel(value) {
  const label = sanitizeDnsLabel(value, '');
  if (!label) throw new TypeError('DNS label cannot be empty');
  return label;
}

/**
 * Build the left-most DNS label used by RunPublic. Long names retain a stable
 * hash suffix so truncation cannot make two different service names collide.
 */
export function createServiceLabel({ project, service, account }) {
  const fullLabel = [
    sanitizeDnsLabel(project, 'project'),
    sanitizeDnsLabel(service, 'service'),
    sanitizeDnsLabel(account, 'user'),
  ].join('-');

  if (fullLabel.length <= DNS_LABEL_LIMIT) return fullLabel;

  const hash = createHash('sha256').update(fullLabel).digest('hex').slice(0, HASH_LENGTH);
  const prefixLength = DNS_LABEL_LIMIT - HASH_LENGTH - 1;
  const prefix = fullLabel.slice(0, prefixLength).replace(/-+$/g, '');
  return `${prefix}-${hash}`;
}

export function normalizeDomain(domain) {
  const normalized = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\.+|\.+$/g, '')
    .split('/')[0];

  // A configured base domain may include a port in local development.
  const withoutPort = normalized.replace(/:\d+$/, '');
  if (!withoutPort || withoutPort.length > 253) {
    throw new TypeError('A valid RunPublic base domain is required');
  }

  const labels = withoutPort.split('.');
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > DNS_LABEL_LIMIT ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new TypeError('A valid RunPublic base domain is required');
  }

  return withoutPort;
}

export function createHostname({ project, service, account, domain }) {
  return `${createServiceLabel({ project, service, account })}.${normalizeDomain(domain)}`;
}

export function createPublicUrl({
  project,
  service,
  account,
  domain,
  scheme = 'https',
  port,
}) {
  const protocol = String(scheme).replace(/:$/, '').toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    throw new TypeError('Public scheme must be http or https');
  }

  const hostname = createHostname({ project, service, account, domain });
  const numericPort = port == null || port === '' ? undefined : Number(port);
  const isDefaultPort =
    numericPort == null ||
    (protocol === 'http' && numericPort === 80) ||
    (protocol === 'https' && numericPort === 443);
  const portPart = isDefaultPort ? '' : `:${numericPort}`;
  return `${protocol}://${hostname}${portPart}`;
}

// Friendly aliases for consumers that prefer build*/slugify terminology.
export const slugify = slugifyDnsLabel;
export const buildHostname = createHostname;
export const buildPublicUrl = createPublicUrl;

export { DNS_LABEL_LIMIT };
