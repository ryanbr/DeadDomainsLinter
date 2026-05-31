const dns = require('dns');
const { promisify } = require('util');

// Note, that we don't use AdGuard DNS servers here in order to not add checked
// domains to the next domains snapshot.
const DNS_SERVERS = [
    '8.8.8.8', // Google
    '1.1.1.1', // Cloudflare
    '9.9.9.9', // Quad9
    '208.67.222.222', // OpenDNS
];

let currentIndex = 0;

/**
 * Returns the next DNS server in the rotation.
 *
 * @returns {string} The DNS server address.
 */
function nextServer() {
    const server = DNS_SERVERS[currentIndex];
    currentIndex = (currentIndex + 1) % DNS_SERVERS.length;
    return server;
}

/**
 * Checks whether a domain looks alive via an A-record query, cycling through
 * DNS servers. "Alive" is interpreted conservatively: anything other than a
 * definitive NXDOMAIN counts as alive (see the catch block), so a domain that
 * resolves, has no A record but exists (ENODATA), or whose lookup merely
 * flaked all return true. Only a confirmed "no such name" returns false.
 *
 * @param {string} domain - Domain name to check with a DNS query.
 * @returns {Promise<boolean>} True unless the name is a definitive NXDOMAIN.
 */
async function domainExists(domain) {
    const resolver = new dns.Resolver();
    resolver.setServers([nextServer()]);
    const resolveAsync = promisify(resolver.resolve).bind(resolver);

    try {
        const addresses = await resolveAsync(domain, 'A');
        return addresses.length > 0;
    } catch (err) {
        // Only a definitive NXDOMAIN (ENOTFOUND) proves the name does not
        // exist. Every other failure is ambiguous: ETIMEOUT/ESERVFAIL/
        // ECONNREFUSED mean the resolver flaked, and ENODATA means the name
        // exists but has no A record (e.g. AAAA- or MX-only). This check is a
        // rescue gate — a live DNS result spares a domain that urlfilter
        // flagged dead — so ambiguous results must count as alive rather than
        // let a transient glitch remove a rule for a live domain.
        return err.code !== dns.NOTFOUND;
    }
}

/**
 * Checks if the domain name exists with one or more DNS queries.
 *
 * @param {string} domain - Domain name to check.
 * @returns {Promise<boolean>} Returns true if the domain is considered alive.
 */
async function checkDomain(domain) {
    let exists = await domainExists(domain);

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
    exists = await domainExists(`www.${domain}`);

    return exists;
}

module.exports = {
    checkDomain,
    domainExists,
};
