const consola = require('consola');
const punycode = require('punycode/');
const { fetchWithRetry, trimFqdn } = require('./fetchdomains');

const CHUNK_SIZE = 25;

/**
 * This function looks for dead domains among the specified ones. It uses a web
 * service to do that.
 *
 * @param {Array<string>} domains domains to check.
 * @param {number} chunkSize configures the size of chunks for checking large
 * arrays.
 * @returns {Promise<Array<string>>} returns the list of dead domains.
 */
async function findDeadDomains(domains, chunkSize = CHUNK_SIZE) {
    const result = [];

    // Split the domains array into chunks
    const chunks = [];
    for (let i = 0; i < domains.length; i += chunkSize) {
        chunks.push(domains.slice(i, i + chunkSize));
    }

    // Compose and send requests for each chunk
    // eslint-disable-next-line no-restricted-syntax
    for (const chunk of chunks) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const response = await fetchWithRetry(chunk);
            // eslint-disable-next-line no-await-in-loop
            const data = await response.json();

            if (data.error) {
                throw new Error(data.error);
            }

            // Iterate over the domains in the chunk
            // eslint-disable-next-line no-restricted-syntax
            for (const domain of chunk) {
                const domainData = data[punycode.toASCII(trimFqdn(domain))];
                if (domainData && domainData.info) {
                    // Only flag a domain dead when the response definitively
                    // says it wasn't used recently.
                    if (domainData.info.registered_domain_used_last_24_hours === false) {
                        result.push(domain);
                    }
                } else {
                    // Entry absent or missing `info` (partial/malformed record,
                    // per-domain error). This is ambiguous, so leave the domain
                    // alive (keep its rule) rather than NPE on domainData.info
                    // and fail the whole chunk over one bad record. Log at
                    // verbose level so a systemic API problem is diagnosable
                    // with -v instead of silently looking like a clean run.
                    consola.verbose(`No usable urlfilter data for ${domain}; treating as alive`);
                }
            }
        } catch (ex) {
            // Re-throw with context about which operation failed.
            throw new Error(`Failed to fetch domains ${ex}`);
        }
    }

    return result;
}

module.exports = {
    findDeadDomains,
};
