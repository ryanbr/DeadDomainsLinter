jest.mock('node-fetch');
const fetch = require('node-fetch');
const agtree = require('@adguard/agtree');
const punycode = require('node:punycode');
const checker = require('../../src/linter');

describe('Linter mocked tests', () => {
    beforeEach(() => {
        fetch.mockReset();
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
});
