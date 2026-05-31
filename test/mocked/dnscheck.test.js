jest.mock('dns', () => {
    const actualDns = jest.requireActual('dns');

    const mockResolver = {
        resolve: jest.fn(),
        setServers: jest.fn(),
    };

    return {
        ...actualDns,
        Resolver: jest.fn(() => mockResolver),
    };
});

const dns = require('dns');
const dnscheck = require('../../src/dnscheck');

// Build an error shaped like a real c-ares rejection (code on .code, not just
// the message), which is what dnscheck inspects.
const dnsError = (code) => Object.assign(new Error(code), { code });

describe('dnscheck mocked tests', () => {
    let mockResolver;

    beforeEach(() => {
        mockResolver = new dns.Resolver();
        jest.clearAllMocks();
    });

    it('check a known existing domain with mocked DNS', async () => {
        // Mock successful DNS resolution
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            callback(null, ['93.184.216.34']);
        });

        const result = await dnscheck.checkDomain('example.org');
        expect(result).toBe(true);
        expect(mockResolver.resolve).toHaveBeenCalledWith('example.org', 'A', expect.any(Function));
    });

    it('check a known non-existing domain with mocked DNS', async () => {
        // Mock DNS resolution failure with a definitive NXDOMAIN.
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            callback(dnsError('ENOTFOUND'));
        });

        const result = await dnscheck.checkDomain('example.nonexistingdomain');
        expect(result).toBe(false);
        expect(mockResolver.resolve).toHaveBeenCalledWith('example.nonexistingdomain', 'A', expect.any(Function));
    });

    it('treats ambiguous DNS failures (timeout/servfail/refused/nodata) as alive', async () => {
        // Each of these means "couldn't determine", not "does not exist". The
        // rescue gate must keep the domain rather than remove a live rule on a
        // transient glitch.
        const ambiguousCodes = ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'ENODATA'];

        // eslint-disable-next-line no-restricted-syntax
        for (const code of ambiguousCodes) {
            mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
                callback(dnsError(code));
            });

            // eslint-disable-next-line no-await-in-loop
            const result = await dnscheck.domainExists('some.domain');
            expect(result).toBe(true);
        }
    });

    it('check a domain that only has a www. record with mocked DNS', async () => {
        // Mock: base domain is NXDOMAIN, www version succeeds.
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            if (domain === 'city.kawasaki.jp') {
                callback(dnsError('ENOTFOUND'));
            } else if (domain === 'www.city.kawasaki.jp') {
                callback(null, ['192.0.2.1']);
            } else {
                callback(dnsError('ENOTFOUND'));
            }
        });

        const noWwwExists = await dnscheck.domainExists('city.kawasaki.jp');
        expect(noWwwExists).toBe(false);

        const result = await dnscheck.checkDomain('city.kawasaki.jp');
        expect(result).toBe(true);

        expect(mockResolver.resolve).toHaveBeenCalledWith('city.kawasaki.jp', 'A', expect.any(Function));
        expect(mockResolver.resolve).toHaveBeenCalledWith('www.city.kawasaki.jp', 'A', expect.any(Function));
    });

    it('should not check www version for www domains', async () => {
        // Mock DNS resolution failure with a definitive NXDOMAIN.
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            callback(dnsError('ENOTFOUND'));
        });

        const result = await dnscheck.checkDomain('www.example.nonexisting');
        expect(result).toBe(false);

        // Should only be called once for the www domain
        expect(mockResolver.resolve).toHaveBeenCalledTimes(1);
        expect(mockResolver.resolve).toHaveBeenCalledWith('www.example.nonexisting', 'A', expect.any(Function));
    });
});
