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

        // Only ONE inter-attempt sleep (between attempt 1 and 2) should occur.
        // After advancing past it, attempt 2 fires, gets 429, and rejects
        // immediately — without a second 2s sleep. If the final attempt still
        // slept, this rejection would not settle until 4s and the test would
        // hang.
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;

        expect(fetch).toHaveBeenCalledTimes(2);
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

    it('does not crash on a malformed entry missing info; treats it as alive', async () => {
        // A chunk where one domain comes back dead, one alive, and one with a
        // malformed record (no `info`). The malformed one must not throw or
        // take the whole chunk down — it's left out of the dead list.
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

        const result = await urlfilter.findDeadDomains(
            ['dead.example', 'alive.example', 'malformed.example'],
        );

        // Only the definitively-dead domain is flagged; the malformed one is
        // treated as alive, not crashed on.
        expect(result).toEqual(['dead.example']);
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
