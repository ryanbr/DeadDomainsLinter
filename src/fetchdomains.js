const dns = require('dns');
const consola = require('consola');
const { Agent } = require('undici');
const punycode = require('punycode/');

/**
 * 503 - Service Unavailable
 * 429 - Too Many Requests
 */
const CODES_TO_RETRY = new Set([503, 429]);

const DECIMAL_BASE = 10;
const ONE_SECOND_MS = 1000;

/**
 * 2 retries for the first request and request after receiving retry-after header.
 */
const DEFAULT_MAX_ATTEMPTS = 2;
const URLFILTER_URL = 'https://urlfilter.adtidy.org/v2/checkDomains';

/**
 * Default dispatcher for requests to adtidy API.
 *
 * Built-in fetch (undici) is prone to ENOTFOUND errors under many parallel
 * requests, so we wire an undici Agent with a custom DNS lookup that caches
 * resolution results permanently. We also use a semaphore-like approach
 * to forbid parallel DNS queries.
 */
const dispatcher = new Agent({
    // eslint-disable-next-line no-use-before-define
    connect: { lookup: dnsLookup },
});

/**
 * In-flight and cached DNS resolutions, keyed by hostname.
 */
const dnsProcessing = {};
const dnsCache = {};

/**
 * Dispatches a lookup result to the node net/tls connector callback in the
 * shape it expects (no NPE on missing/empty addresses).
 *
 * @param {Error|null} err - Lookup error, if any.
 * @param {Array|undefined} addresses - Resolved addresses from dns.lookup with
 * {all: true} or undefined if the lookup failed.
 * @param {string} hostname - Hostname being resolved (for error messages).
 * @param {object} options - Original lookup options ({all}).
 * @param {Function} cb - Connector callback.
 */
function deliver(err, addresses, hostname, options, cb) {
    if (err || !addresses || addresses.length === 0) {
        cb(err || new Error(`No A records for ${hostname}`));
        return;
    }
    if (options.all) {
        cb(null, addresses);
        return;
    }
    const addr = addresses[0];
    cb(null, addr.address, addr.family);
}

/**
 * Custom DNS lookup function that caches resolution results permanently and
 * funnels concurrent queries for the same hostname through a single in-flight
 * dns.lookup call.
 *
 * @param {string} hostname - The hostname to resolve.
 * @param {object} options - The options object.
 * @param {boolean} options.all - If true, return all resolved addresses.
 * @param {Function} cb - The callback function.
 */
function dnsLookup(hostname, options, cb) {
    const cached = dnsCache[hostname];
    if (cached) {
        deliver(null, cached, hostname, options, cb);
        return;
    }

    if (dnsProcessing[hostname]) {
        // If a query for this hostname is already processing, wait until it's
        // finished.
        setTimeout(() => {
            dnsLookup(hostname, options, cb);
        }, 10);

        return;
    }

    dnsProcessing[hostname] = true;
    dns.lookup(hostname, { all: true, family: 4 }, (err, addresses) => {
        delete dnsProcessing[hostname];

        if (err === null && addresses && addresses.length > 0) {
            dnsCache[hostname] = addresses;
        }

        deliver(err, addresses, hostname, options, cb);
    });
}

/**
 * Removes trailing dot from an fully qualified domain name. The reason for
 * that is that urlfilter service does not know how to work with FQDN.
 *
 * @param {string} domain - The domain name to trim.
 * @returns {string} The domain name without trailing dot.
 */
function trimFqdn(domain) {
    return domain.endsWith('.') ? domain.slice(0, -1) : domain;
}

/**
 * Parses `Retry-After` header (seconds or HTTP date).
 *
 * @param {string} retryAfter - Header value.
 * @returns {number|null} Non-negative delay in milliseconds, or null if the
 * header could not be parsed. Note that 0 is a valid delay (retry immediately)
 * and is distinct from null.
 */
function parseRetryAfter(retryAfter) {
    if (/^\d+$/.test(retryAfter)) {
        return parseInt(retryAfter, DECIMAL_BASE) * ONE_SECOND_MS; // Seconds to ms
    }
    const date = new Date(retryAfter);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    // A date in the past means "retry now"; clamp negatives to 0.
    return Math.max(0, date - Date.now());
}

/**
 * Fetches a URL with retries respecting `Retry-After` headers.
 *
 * @param {string[]} domains - List of domains to fetch.
 * @param {number} [maxAttempts] - Maximum retry attempts
 * @throws {Error} If all attempts fail or fetch encounters network errors.
 * @returns {Promise<Response>} Fetch response.
 */
async function fetchWithRetry(domains, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    const url = new URL(`${URLFILTER_URL}`);
    url.searchParams.append('filter', 'none');

    domains.forEach((domain) => {
        const asciiDomain = punycode.toASCII(domain);
        url.searchParams.append('domain', trimFqdn(asciiDomain));
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(url, {
            dispatcher,
        });

        if (response.ok) {
            return response;
        }

        const retryAfter = response.headers.get('Retry-After');
        if (!CODES_TO_RETRY.has(response.status)) {
            throw new Error(`Failed to fetch domains response code - ${response.status}`);
        }
        if (!retryAfter) {
            throw new Error(`Fetch status - ${response.status}, but no retry-after received for ${url}`);
        }

        const delayMs = parseRetryAfter(retryAfter);
        if (delayMs === null) {
            throw new Error(`Unable to parse retry-after header -${retryAfter}`);
        }

        // If this was the last attempt, don't sleep — we're about to give up.
        if (attempt >= maxAttempts) {
            break;
        }

        consola.info(`Retry required (attempt ${attempt}): Waiting ${delayMs}ms`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
        });
    }
    throw Error(`Fetch domains failed: ${url}, tried ${maxAttempts} times`);
}

module.exports = {
    fetchWithRetry,
    trimFqdn,
};
