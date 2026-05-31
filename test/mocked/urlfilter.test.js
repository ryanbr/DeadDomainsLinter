const consola = require('consola');
const urlfilter = require('../../src/urlfilter');
const { createRateLimitedResponse, createSuccessResponse } = require('./mockresponse');

describe('urlfilter tests with mocked api calls', () => {
    let fetch;
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetch = jest.fn();
        global.fetch = fetch;
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        global.fetch = originalFetch;
    });

    const testRetryAfter = async (retryAfterValue, domain = 'example.notexisting') => {
        fetch.mockResolvedValueOnce(createRateLimitedResponse(retryAfterValue));
        fetch.mockResolvedValueOnce(createSuccessResponse([domain]));

        const promise = urlfilter.findDeadDomains([domain]);
        expect(fetch).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(result).toEqual([domain]);
    };

    it('should handle 429 with retry-after header with seconds', async () => {
        await testRetryAfter('2');
    });

    it('should handle 429 with retry-after header with Date', async () => {
        await testRetryAfter(new Date(Date.now() + 2000));
    });

    it('treats Retry-After: 0 as a valid immediate retry, not a parse failure', async () => {
        fetch.mockResolvedValueOnce(createRateLimitedResponse('0'));
        fetch.mockResolvedValueOnce(createSuccessResponse(['example.notexisting']));

        const promise = urlfilter.findDeadDomains(['example.notexisting']);
        // The retry sleep is setTimeout(_, 0); flush it.
        await jest.advanceTimersByTimeAsync(0);
        const result = await promise;

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(result).toEqual(['example.notexisting']);
    });

    it('gives up after maxAttempts without sleeping on the final attempt', async () => {
        // Every attempt is rate-limited with a 2s Retry-After.
        fetch.mockResolvedValue(createRateLimitedResponse('2'));

        const promise = urlfilter.findDeadDomains(['example.notexisting']);
        const rejection = expect(promise).rejects.toThrow();

        // maxAttempts is 3, so there are sleeps after attempts 1 and 2 but NOT
        // after the final attempt 3. Advancing past the two 2s sleeps lets the
        // third attempt fire and reject immediately; if the final attempt still
        // slept, the rejection would not settle and the test would hang.
        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;

        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('retries on a network-level fetch failure and succeeds', async () => {
        // Pin jitter so the backoff is deterministic: factor 0.5 + 0.5 = 1.0,
        // so the delay equals the base (500ms for attempt 1).
        const rnd = jest.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            // undici surfaces a transient connection failure (e.g. a keep-alive
            // socket reset) as a thrown TypeError with the real reason on .cause.
            const netErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
            fetch.mockRejectedValueOnce(netErr);
            fetch.mockResolvedValueOnce(createSuccessResponse(['example.notexisting']));

            const promise = urlfilter.findDeadDomains(['example.notexisting']);
            await jest.advanceTimersByTimeAsync(500); // network-retry backoff
            const result = await promise;

            expect(fetch).toHaveBeenCalledTimes(2);
            expect(result).toEqual(['example.notexisting']);
        } finally {
            rnd.mockRestore();
        }
    });

    it('gives up after repeated network failures, surfacing the underlying cause', async () => {
        const rnd = jest.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            const netErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
            fetch.mockRejectedValue(netErr); // every attempt fails at the network level

            const promise = urlfilter.findDeadDomains(['example.notexisting']);
            const rejection = expect(promise).rejects.toThrow(/ECONNRESET/);

            // maxAttempts is 3 -> backoffs after attempts 1 and 2: base*2^0=500ms
            // then base*2^1=1000ms (jitter pinned to factor 1.0).
            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(1000);
            await rejection;

            expect(fetch).toHaveBeenCalledTimes(3);
        } finally {
            rnd.mockRestore();
        }
    });

    it('check a domain that we know does exist', async () => {
        fetch.mockResolvedValueOnce(createSuccessResponse([], ['example.org']));

        const result = await urlfilter.findDeadDomains(['example.org']);
        expect(result).toEqual([]);
    });

    it('check a domain that we know does NOT exist', async () => {
        fetch.mockResolvedValueOnce(createSuccessResponse(['example.atatatata.baababbaba']));

        const result = await urlfilter.findDeadDomains(['example.atatatata.baababbaba']);
        expect(result).toEqual(['example.atatatata.baababbaba']);
    });

    it('check an fqdn domain name', async () => {
        fetch.mockResolvedValueOnce(createSuccessResponse(['example.notexisting']));

        const result = await urlfilter.findDeadDomains(['example.notexisting.']);
        expect(result).toEqual(['example.notexisting.']);
    });

    it('does not crash on a malformed entry missing info; treats it as alive and logs it', async () => {
        // A chunk where one domain comes back dead, one alive, and one with a
        // malformed record (no `info`). The malformed one must not throw or
        // take the whole chunk down — it's left out of the dead list, and a
        // verbose log is emitted so a systemic issue is diagnosable.
        const responseData = {
            'dead.example': { info: { registered_domain_used_last_24_hours: false }, matches: [] },
            'alive.example': { info: { registered_domain_used_last_24_hours: true }, matches: [] },
            'malformed.example': { error: 'could not check', matches: [] }, // no info
        };
        fetch.mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: { get: () => 'application/json' },
            json: jest.fn().mockResolvedValue(responseData),
        });

        const verboseSpy = jest.spyOn(consola, 'verbose').mockImplementation(() => {});

        try {
            const result = await urlfilter.findDeadDomains(
                ['dead.example', 'alive.example', 'malformed.example'],
            );

            // Only the definitively-dead domain is flagged; the malformed one is
            // treated as alive, not crashed on.
            expect(result).toEqual(['dead.example']);
            // The ambiguous entry is logged (verbose) exactly once.
            expect(verboseSpy).toHaveBeenCalledTimes(1);
            expect(verboseSpy).toHaveBeenCalledWith(expect.stringContaining('malformed.example'));
        } finally {
            verboseSpy.mockRestore();
        }
    });

    it('checks lots of domains using two chunks', async () => {
        const domains = [];
        for (let i = 0; i < 10; i += 1) {
            domains.push(`example${i}.notexistingtld`);
        }

        // Mock two API calls (for two chunks)
        fetch.mockResolvedValueOnce(createSuccessResponse(domains.slice(0, 5)));
        fetch.mockResolvedValueOnce(createSuccessResponse(domains.slice(5)));

        const result = await urlfilter.findDeadDomains(domains, 5);
        expect(result).toEqual(domains);
    });
});
