const dnscheck = require('../../src/dnscheck');

describe('dnscheck', () => {
    it('check a known existing domain', async () => {
        const result = await dnscheck.checkDomain('example.org');

        expect(result).toBe(true);
    });

    it('check a known non-existing domain', async () => {
        const result = await dnscheck.checkDomain('example.nonexistingdomain');

        expect(result).toBe(false);
    });

    it('treats a domain that exists but has no apex A record as alive', async () => {
        // city.kawasaki.jp has no A record on the apex (only www.* does), so a
        // direct A query returns ENODATA — "exists, no record of this type",
        // not NXDOMAIN. domainExists must treat that as alive: the name clearly
        // exists, so the DNS rescue gate should not let it be removed.
        // If the apex ever gains/loses records we'll need a different domain.
        const apexExists = await dnscheck.domainExists('city.kawasaki.jp');
        expect(apexExists).toBe(true);

        const result = await dnscheck.checkDomain('city.kawasaki.jp');
        expect(result).toBe(true);
    });
});
