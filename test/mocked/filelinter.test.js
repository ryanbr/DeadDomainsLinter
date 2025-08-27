jest.mock('node-fetch');
const fetch = require('node-fetch');
const fileLinter = require('../../src/filelinter');
const { createSuccessResponse } = require('./mockresponse');

describe('File linter with mocked API', () => {
    beforeEach(() => {
        fetch.mockReset();
    });

    it('test a simple automatic run with mocked API', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        const fileResult = await fileLinter.lintFile('test/resources/filter.txt', {
            auto: true,
            ignoreDomains: new Set(),
        });

        expect(fileResult).toBeDefined();
        expect(fileResult.listAst).toBeDefined();
        expect(fileResult.results).toBeDefined();

        // Should find 4 issues:
        // 1. ||example.org^$domain=example.notexisting (dead domain in $domain)
        // 2. ||example.org^$domain=~example.notexisting (dead negated domain in $domain)
        // 3. example.notexisting##banner (dead domain in cosmetic rule)
        // 4. ||anotherdeaddomain.examplee^ (dead domain in network rule)
        expect(fileResult.results).toHaveLength(4);
    });

    it('should ignore domains in ignoreDomains set', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        const fileResult = await fileLinter.lintFile('test/resources/filter.txt', {
            auto: true,
            ignoreDomains: new Set(['example.notexisting']),
        });

        expect(fileResult).toBeDefined();

        // Should only find 1 issue now (the rule with 'anotherdeaddomain.examplee' which is not ignored)
        // The rules with example.notexisting should be ignored
        expect(fileResult.results).toHaveLength(1);
    });
});
