const agtree = require('@adguard/agtree');
const punycode = require('punycode/');
const checker = require('../../src/linter');
const dnscheck = require('../../src/dnscheck');

describe('Linter mocked tests', () => {
    let fetch;
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetch = jest.fn();
        global.fetch = fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    const testLintRule = (rule, expected, ignoreDomains = new Set()) => {
        return async () => {
            const deadDomainsToMock = expected?.deadDomains.map((domain) => punycode.toASCII(domain)) || [];

            fetch.mockImplementation(async (url) => {
                const urlObj = new URL(url);
                const requestedDomains = urlObj.searchParams.getAll('domain');
                const responseData = {};

                requestedDomains.forEach((domain) => {
                    const isDead = deadDomainsToMock.includes(domain);
                    responseData[domain] = {
                        info: {
                            domain_name: domain,
                            registered_domain: domain,
                            registered_domain_used_last_24_hours: !isDead,
                            used_last_24_hours: !isDead,
                        },
                        matches: [],
                    };
                });

                return {
                    status: 200,
                    ok: true,
                    headers: { get: () => 'application/json' },
                    json: jest.fn().mockResolvedValue(responseData),
                };
            });

            const ast = agtree.RuleParser.parse(rule);
            const result = await checker.lintRule(ast, { useDNS: false, ignoreDomains });

            if (expected === null) {
                expect(result).toEqual(null);
                return;
            }

            if (expected.remove) {
                expect(result.suggestedRule).toEqual(null);
            } else {
                const ruleText = agtree.RuleParser.generate(result.suggestedRule);
                expect(ruleText).toEqual(expected.suggestedRuleText);
            }

            expect(result.deadDomains).toEqual(expected.deadDomains);
        };
    };

    it('suggest removing rule with a dead domain in the pattern', testLintRule(
        '||example.notexistingdomain^',
        { remove: true, deadDomains: ['example.notexistingdomain'] },
    ));

    it('suggest removing rule with a dead domain in the pattern URL', testLintRule(
        '||example.notexistingdomain/thisissomepath/tosomewhere',
        { remove: true, deadDomains: ['example.notexistingdomain'] },
    ));

    it('ignore removing rule with a dead domain in the pattern URL', testLintRule(
        '||example.notexistingdomain/thisissomepath/tosomewhere',
        null,
        new Set(['example.notexistingdomain']),
    ));

    it('do not suggest removing IP addresses', testLintRule(
        '||1.2.3.4^',
        null,
    ));

    it('do not suggest removing .onion domains', testLintRule(
        '||example.onion^',
        null,
    ));

    it('suggest removing dead non ASCII domain from modifier', testLintRule(
        '||example.org^$domain=ппример2.рф',
        { remove: true, deadDomains: ['ппример2.рф'] },
    ));

    it('do nothing with a simple rule with existing domain', testLintRule(
        '||example.org^$third-party',
        null,
    ));

    it('suggest removing negated domain from $domain', testLintRule(
        '||example.org^$domain=example.org|example.notexistingdomain',
        { suggestedRuleText: '||example.org^$domain=example.org', deadDomains: ['example.notexistingdomain'] },
    ));

    it('suggest removing the whole rule when all permitted domains are dead', testLintRule(
        '||example.org^$domain=example.notexisting1|example.notexisting2',
        { remove: true, deadDomains: ['example.notexisting1', 'example.notexisting2'] },
    ));

    it('ignore dead domain as part of $domain modifier', testLintRule(
        '||example.org^$domain=example.notexisting1|google.com|example.notexisting2',
        {
            suggestedRuleText: '||example.org^$domain=example.notexisting1|google.com',
            deadDomains: ['example.notexisting2'],
        },
        new Set(['example.notexisting1']),
    ));

    // $denyallow is an exclusion list, not a positive scope: dead domains in
    // it must drop the modifier (or just the dead entries), never remove the
    // whole rule — that would silently disable active blocking.
    it('drops $denyallow modifier when its only domain is dead, keeping the rule', testLintRule(
        '||ads.example^$denyallow=example.notexistingdomain',
        { suggestedRuleText: '||ads.example^', deadDomains: ['example.notexistingdomain'] },
    ));

    it('drops $denyallow modifier when all its domains are dead, keeping the rule', testLintRule(
        '||ads.example^$denyallow=example.notexisting1|example.notexisting2',
        { suggestedRuleText: '||ads.example^', deadDomains: ['example.notexisting1', 'example.notexisting2'] },
    ));

    it('removes only dead entries from a mixed $denyallow list', testLintRule(
        '||ads.example^$denyallow=example.notexistingdomain|google.com',
        {
            suggestedRuleText: '||ads.example^$denyallow=google.com',
            deadDomains: ['example.notexistingdomain'],
        },
    ));

    // The common real-world shape: $denyallow accompanies a live $domain
    // (uBO requires denyallow to be used together with domain). The dead
    // denyallow entry is dropped while the live $domain scope is preserved.
    it('drops a dead $denyallow but keeps a live $domain scope', testLintRule(
        '||ads.example^$domain=google.com,denyallow=example.notexistingdomain',
        {
            suggestedRuleText: '||ads.example^$domain=google.com',
            deadDomains: ['example.notexistingdomain'],
        },
    ));

    // When the positive $domain scope is itself all dead, the rule is still
    // removed regardless of $denyallow — the exclusion exception doesn't
    // rescue a rule that applies nowhere.
    it('removes the rule when $domain is all dead even alongside $denyallow', testLintRule(
        '||ads.example^$domain=example.notexisting1,denyallow=example.notexisting2',
        { remove: true, deadDomains: ['example.notexisting1', 'example.notexisting2'] },
    ));

    // Cosmetic rules tests
    it('suggest removing an element hiding rule which was only for dead domains', testLintRule(
        'example.notexistingdomain##banner',
        { remove: true, deadDomains: ['example.notexistingdomain'] },
    ));

    it('ignore removing an element hiding rule for dead domains', testLintRule(
        'example.notexistingdomain##banner',
        null,
        new Set(['example.notexistingdomain']),
    ));

    it('keep the rule if there are permitted domains left', testLintRule(
        'example.org,example.notexistingdomain##banner',
        { suggestedRuleText: 'example.org##banner', deadDomains: ['example.notexistingdomain'] },
    ));

    it('keep the rule if all dead domains were negated', testLintRule(
        '~example.notexistingdomain##banner',
        { suggestedRuleText: '##banner', deadDomains: ['example.notexistingdomain'] },
    ));

    it('suggest removing a scriptlet rule', testLintRule(
        'example.notexistingdomain#%#//scriptlet("set-constant", "a", "1")',
        { remove: true, deadDomains: ['example.notexistingdomain'] },
    ));

    it('ignore removing a scriptlet rule with ignore domain', testLintRule(
        'example.notexistingdomain#%#//scriptlet("set-constant", "a", "1")',
        null,
        new Set(['example.notexistingdomain']),
    ));

    // --no-urlfilter: DNS is the sole detector, urlfilter is never called.
    it('noUrlfilter: detects a non-resolving domain via DNS without calling urlfilter', async () => {
        const checkSpy = jest.spyOn(dnscheck, 'checkDomain')
            .mockImplementation(async (domain) => !domain.includes('dead')); // 'dead' -> not alive

        try {
            const ast = agtree.RuleParser.parse('||dead.example^');
            const result = await checker.lintRule(ast, {
                noUrlfilter: true,
                ignoreDomains: new Set(),
            });

            expect(result.deadDomains).toEqual(['dead.example']);
            // The urlfilter web service (global.fetch) must not be touched.
            expect(fetch).not.toHaveBeenCalled();
            expect(checkSpy).toHaveBeenCalledWith('dead.example', expect.any(Object));
        } finally {
            checkSpy.mockRestore();
        }
    });

    it('noUrlfilter: keeps a domain that still resolves', async () => {
        const checkSpy = jest.spyOn(dnscheck, 'checkDomain').mockResolvedValue(true); // all alive

        try {
            const ast = agtree.RuleParser.parse('||alive.example^');
            const result = await checker.lintRule(ast, {
                noUrlfilter: true,
                ignoreDomains: new Set(),
            });

            expect(result).toBeNull(); // nothing dead -> no issue
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            checkSpy.mockRestore();
        }
    });

    it('suggest modifying a scriptlet rule', testLintRule(
        'example.org,example.notexistingdomain#%#//scriptlet("set-constant", "a", "1")',
        {
            suggestedRuleText: 'example.org#%#//scriptlet("set-constant", "a", "1")',
            deadDomains: ['example.notexistingdomain'],
        },
    ));

    it('ignore modifying a scriptlet rule with ignore domain', testLintRule(
        'example.org,example.notexistingdomain#%#//scriptlet("set-constant", "a", "1")',
        null,
        new Set(['example.notexistingdomain']),
    ));

    it('dedupes in-flight lookups for the same domain across concurrent lintRule calls', async () => {
        // Use unique domains so the module-level cache from prior tests doesn't
        // satisfy the lookup before fetch is called.
        const shared = `racy.${Date.now()}.example.invalid`;

        // Hold the fetch resolution until both lintRule calls have queued.
        let releaseFetch;
        const fetchGate = new Promise((r) => { releaseFetch = r; });

        fetch.mockImplementation(async (url) => {
            await fetchGate;
            const requested = new URL(url).searchParams.getAll('domain');
            const data = {};
            requested.forEach((d) => {
                data[d] = {
                    info: {
                        domain_name: d,
                        registered_domain: d,
                        registered_domain_used_last_24_hours: false,
                        used_last_24_hours: false,
                    },
                    matches: [],
                };
            });
            return {
                status: 200,
                ok: true,
                headers: { get: () => 'application/json' },
                json: jest.fn().mockResolvedValue(data),
            };
        });

        const ast1 = agtree.RuleParser.parse(`||${shared}^`);
        const ast2 = agtree.RuleParser.parse(`||${shared}^$third-party`);

        const p1 = checker.lintRule(ast1, { useDNS: false, ignoreDomains: new Set() });
        const p2 = checker.lintRule(ast2, { useDNS: false, ignoreDomains: new Set() });

        releaseFetch();
        const [r1, r2] = await Promise.all([p1, p2]);

        // Both rules see the dead domain.
        expect(r1.deadDomains).toEqual([shared]);
        expect(r2.deadDomains).toEqual([shared]);

        // Pre-fix, the same domain would trigger two fetches. With the
        // promise cache the second lintRule call sees the in-flight entry
        // and awaits the same batch, so fetch should be called exactly once.
        // (The gated mock guarantees the second call runs before the first
        // batch resolves, so it can't slip past the cache.)
        expect(fetch.mock.calls.length).toBe(1);
    });

    it('evicts cache entries when the urlfilter batch fails so future calls retry', async () => {
        const target = `flaky.${Date.now()}.example.invalid`;

        // First call: fetch rejects, so the linter call rejects and the cache
        // entry is evicted.
        fetch.mockImplementationOnce(async () => { throw new Error('network down'); });

        const ast = agtree.RuleParser.parse(`||${target}^`);
        await expect(
            checker.lintRule(ast, { useDNS: false, ignoreDomains: new Set() }),
        ).rejects.toThrow();

        // Second call: fetch succeeds. If the cache still held the rejected
        // promise from the first call, this would also throw.
        fetch.mockImplementationOnce(async (url) => {
            const requested = new URL(url).searchParams.getAll('domain');
            const data = {};
            requested.forEach((d) => {
                data[d] = {
                    info: {
                        domain_name: d,
                        registered_domain: d,
                        registered_domain_used_last_24_hours: false,
                        used_last_24_hours: false,
                    },
                    matches: [],
                };
            });
            return {
                status: 200,
                ok: true,
                headers: { get: () => 'application/json' },
                json: jest.fn().mockResolvedValue(data),
            };
        });

        const result = await checker.lintRule(ast, { useDNS: false, ignoreDomains: new Set() });
        expect(result.deadDomains).toEqual([target]);
    });
});
