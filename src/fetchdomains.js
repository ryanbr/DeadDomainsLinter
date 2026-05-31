const dns = require('dns');
const consola = require('consola');
const { Agent, setGlobalDispatcher } = require('undici');
const punycode = require('punycode/');

// We deliberately enable undici's HTTP/2 (allowH2 below) because it is what
// fixes connection churn on large runs. undici emits a one-time experimental
// warning for h2; silence just that one so it doesn't clutter every CLI run,
// while passing every other warning through untouched.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...args) {
    const opts = (typeof args[0] === 'object' && args[0] !== null) ? args[0] : null;
    const code = opts ? opts.code : args[0];
    const message = typeof warning === 'string' ? warning : (warning && warning.message);
    if (code === 'UNDICI-H2' || (message && message.includes('H2 support is experimental'))) {
        return undefined;
    }
    return originalEmitWarning.call(process, warning, ...args);
};

/**
 * 503 - Service Unavailable
 * 429 - Too Many Requests
 */
const CODES_TO_RETRY = new Set([503, 429]);

const DECIMAL_BASE = 10;
const ONE_SECOND_MS = 1000;

/**
 * Total number of attempts per request: the initial call plus retries, used for
 * both Retry-After responses (429/503) and network-level failures (3 attempts
 * = 2 retries). The extra retry beyond a bare 1 gives transient connection
 * blips — keep-alive socket resets in particular — more than one chance to
 * reconnect before the batch is abandoned.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Base backoff before retrying a network-level fetch failure. Retries use
 * exponential growth with jitter on top of this (see backoffMs).
 */
const NETWORK_RETRY_DELAY_MS = 500;

/**
 * Upper bound on simultaneous connections undici keeps open to the adtidy
 * origin. With HTTP/2 (below) a single connection multiplexes everything, so
 * this is mostly a safety cap rather than the workhorse.
 */
const MAX_CONNECTIONS = 16;
const URLFILTER_URL = 'https://urlfilter.adtidy.org/v2/checkDomains';

/**
 * Default dispatcher for requests to adtidy API.
 *
 * Built-in fetch (undici) is prone to ENOTFOUND errors under many parallel
 * requests, so we wire an undici Agent with a custom DNS lookup that caches
 * resolution results permanently. We also use a semaphore-like approach
 * to forbid parallel DNS queries.
 *
 * allowH2 is the key setting for large runs: the urlfilter server responds with
 * `Connection: close`, so over HTTP/1.1 every one of the tens of thousands of
 * per-rule requests opens a fresh TCP+TLS connection — that connection churn is
 * what produced UND_ERR_CONNECT_TIMEOUT storms once the rate tripped the
 * server's connection limits. The server speaks HTTP/2, which multiplexes all
 * those requests over a single connection, so the churn disappears (a 20-
 * request burst goes from 20 connections to 1). keepAlive keeps that h2
 * connection warm.
 *
 * It is installed via setGlobalDispatcher rather than passed per-request as
 * fetch(url, { dispatcher }). The per-request option is not reliably honoured
 * by global fetch across the whole supported Node range (>=18) — on older 18.x
 * it can be silently ignored, which would disable this DNS cache and bring back
 * the ENOTFOUND-under-load problem with no error. setGlobalDispatcher is the
 * documented, version-stable way to customise global fetch's agent, and this is
 * a single-purpose CLI so a process-global dispatcher is fine.
 */
const dispatcher = new Agent({
    // eslint-disable-next-line no-use-before-define
    connect: { lookup: dnsLookup },
    allowH2: true,
    connections: MAX_CONNECTIONS,
    keepAliveTimeout: 60 * ONE_SECOND_MS,
    keepAliveMaxTimeout: 10 * 60 * ONE_SECOND_MS,
});
setGlobalDispatcher(dispatcher);

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
 * Sleeps for the given number of milliseconds.
 *
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Exponential backoff with jitter for the Nth network retry. Jitter matters
 * because connect timeouts arrive in synchronized bursts (many batches fail at
 * once); spreading the retries keeps them from hitting a recovering server as
 * one wave.
 *
 * @param {number} attempt - 1-based attempt number that just failed.
 * @returns {number} Delay in milliseconds before the next attempt.
 */
function backoffMs(attempt) {
    const base = NETWORK_RETRY_DELAY_MS * (2 ** (attempt - 1));
    // Full jitter in [0.5, 1.5) * base.
    return Math.round(base * (0.5 + Math.random()));
}

/**
 * Renders an error for logging, unwrapping the `cause` that fetch/undici hides
 * behind a generic "fetch failed" TypeError.
 *
 * @param {Error} err - The error to describe.
 * @returns {string} A human-readable description including the underlying cause.
 */
function describeError(err) {
    if (!err) {
        return String(err);
    }
    const { cause } = err;
    if (cause && (cause.code || cause.message)) {
        return `${err.message} (${cause.code || cause.message})`;
    }
    return err.message;
}

/**
 * Fetches a URL with retries. Retries on `Retry-After` responses (429/503) and
 * on network-level failures — undici surfaces transient connection problems
 * (keep-alive socket resets, ECONNRESET, connect timeouts) as a thrown
 * "fetch failed" TypeError, and a single bad socket shouldn't abort a whole
 * 25-domain batch.
 *
 * @param {string[]} domains - List of domains to fetch.
 * @param {number} [maxAttempts] - Maximum total attempts (initial call + retries).
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
        let response = null;

        try {
            // The custom DNS-caching dispatcher is installed globally above.
            // eslint-disable-next-line no-await-in-loop
            response = await fetch(url);
        } catch (err) {
            // Network-level failure (fetch itself threw). Retry it like a 5xx
            // — a fresh attempt opens a new socket, which fixes a stale
            // keep-alive connection — instead of failing the batch outright.
            if (attempt >= maxAttempts) {
                throw new Error(
                    `Network error fetching domains after ${maxAttempts} attempts: ${describeError(err)}`,
                );
            }
            const delayMs = backoffMs(attempt);
            consola.info(`Network error (attempt ${attempt}), retrying in ${delayMs}ms: ${describeError(err)}`);
            // eslint-disable-next-line no-await-in-loop
            await sleep(delayMs);
        }

        // response stays null when the fetch threw and was scheduled for retry.
        if (response !== null) {
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
            await sleep(delayMs);
        }
    }
    throw Error(`Fetch domains failed: ${url}, tried ${maxAttempts} times`);
}

module.exports = {
    fetchWithRetry,
    trimFqdn,
};
