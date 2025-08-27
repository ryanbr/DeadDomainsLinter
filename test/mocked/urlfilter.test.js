jest.mock('node-fetch');

const fetch = require('node-fetch');
const urlfilter = require('../../src/urlfilter');
const { createRateLimitedResponse, createSuccessResponse } = require('./mockresponse');

describe('urlfilter tests with mocked api calls', () => {
    beforeEach(() => {
        fetch.mockReset();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
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
