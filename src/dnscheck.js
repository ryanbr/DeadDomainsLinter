const dns = require('dns');
const { promisify } = require('util');

// Note, that we don't use AdGuard DNS servers here in order to not add checked
// domains to the next domains snapshot.
const DEFAULT_DNS_SERVERS = [
    '8.8.8.8', // Google
    '1.1.1.1', // Cloudflare
    '9.9.9.9', // Quad9
    '208.67.222.222', // OpenDNS
];

// Monotonic counter used to round-robin across the server pool. Module-global
// so load is spread across the whole run, not reset per call.
let counter = 0;

/**
 * Returns the next DNS server in the rotation for the given pool.
 *
 * @param {Array<string>} servers - The pool to rotate through.
 * @returns {string} The DNS server address.
 */
function nextServer(servers) {
    const server = servers[counter % servers.length];
    counter += 1;
    return server;
}

/**
 * Queries a single resolver for an A record and classifies the outcome.
 *
 * @param {string} domain - Domain to resolve.
 * @param {string} server - DNS server address to query.
 * @returns {Promise<'alive'|'dead'|'ambiguous'>} 'alive' if it resolves,
 * 'dead' on a definitive NXDOMAIN, 'ambiguous' for anything else (no A record,
 * timeout, SERVFAIL, refused, or a bad server address).
 */
async function queryServer(domain, server) {
    const resolver = new dns.Resolver();
    try {
        // setServers can throw on a malformed address; keep it inside the try
        // so a bad server degrades to 'ambiguous' rather than crashing.
        resolver.setServers([server]);
        const resolveAsync = promisify(resolver.resolve).bind(resolver);
        const addresses = await resolveAsync(domain, 'A');
        return addresses.length > 0 ? 'alive' : 'ambiguous';
    } catch (err) {
        // Only a definitive NXDOMAIN proves the name does not exist. Every
        // other failure is ambiguous (see domainExists for the rationale).
        return err.code === dns.NOTFOUND ? 'dead' : 'ambiguous';
    }
}

/**
 * Options for the DNS check.
 *
 * @typedef {object} DnsCheckOptions
 * @property {Array<string>} [servers] - Resolver pool to use instead of the
 * defaults.
 * @property {boolean} [rotate] - If true, an ambiguous result rotates to the
 * next server(s) for the same domain until a definitive answer is found.
 */

/**
 * Checks whether a domain looks alive via an A-record query. "Alive" is
 * interpreted conservatively: anything other than a definitive NXDOMAIN counts
 * as alive, so a domain that resolves, has no A record but exists (ENODATA), or
 * whose lookup merely flaked all return true. Only a confirmed "no such name"
 * returns false.
 *
 * Without `rotate`, a single round-robined server answers the query (the next
 * call uses the next server). With `rotate`, ambiguous results fall back to the
 * next server(s) and the first definitive answer (resolves = alive, NXDOMAIN =
 * dead) wins; if every server is ambiguous, the domain is treated as alive.
 *
 * @param {string} domain - Domain name to check with a DNS query.
 * @param {DnsCheckOptions} [options] - DNS check configuration.
 * @returns {Promise<boolean>} True unless the name is a definitive NXDOMAIN.
 */
async function domainExists(domain, options = {}) {
    const servers = (options.servers && options.servers.length > 0)
        ? options.servers
        : DEFAULT_DNS_SERVERS;

    if (!options.rotate) {
        // Single resolver per query (round-robin across the pool).
        const state = await queryServer(domain, nextServer(servers));
        return state !== 'dead';
    }

    // Fallback rotation: try servers in turn until one is decisive.
    for (let i = 0; i < servers.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const state = await queryServer(domain, nextServer(servers));
        if (state === 'alive') {
            return true;
        }
        if (state === 'dead') {
            return false;
        }
        // ambiguous -> try the next server
    }

    // Every server was ambiguous -> conservatively treat as alive.
    return true;
}

/**
 * Checks if the domain name exists with one or more DNS queries.
 *
 * @param {string} domain - Domain name to check.
 * @param {DnsCheckOptions} [options] - DNS check configuration.
 * @returns {Promise<boolean>} Returns true if the domain is considered alive.
 */
async function checkDomain(domain, options) {
    let exists = await domainExists(domain, options);

    if (exists) {
        return true;
    }

    if (domain.startsWith('www.')) {
        // If this is a www. domain name, there's no need to doublecheck it.
        return false;
    }

    // Double-check a www. version of a domain name. We do this because there
    // are some cases when it's necessary:
    // https://github.com/AdguardTeam/DeadDomainsLinter/issues/16
    exists = await domainExists(`www.${domain}`, options);

    return exists;
}

module.exports = {
    checkDomain,
    domainExists,
    DEFAULT_DNS_SERVERS,
};
