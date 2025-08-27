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
        // Mock DNS resolution failure
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            callback(new Error('ENOTFOUND'));
        });

        const result = await dnscheck.checkDomain('example.nonexistingdomain');
        expect(result).toBe(false);
        expect(mockResolver.resolve).toHaveBeenCalledWith('example.nonexistingdomain', 'A', expect.any(Function));
    });

    it('check a domain that only has a www. record with mocked DNS', async () => {
        // Mock: base domain fails, www version succeeds
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            if (domain === 'city.kawasaki.jp') {
                callback(new Error('ENOTFOUND'));
            } else if (domain === 'www.city.kawasaki.jp') {
                callback(null, ['192.0.2.1']);
            } else {
                callback(new Error('Unexpected domain'));
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
        // Mock DNS resolution failure
        mockResolver.resolve.mockImplementation((domain, rrtype, callback) => {
            callback(new Error('ENOTFOUND'));
        });

        const result = await dnscheck.checkDomain('www.example.nonexisting');
        expect(result).toBe(false);

        // Should only be called once for the www domain
        expect(mockResolver.resolve).toHaveBeenCalledTimes(1);
        expect(mockResolver.resolve).toHaveBeenCalledWith('www.example.nonexisting', 'A', expect.any(Function));
    });
});
