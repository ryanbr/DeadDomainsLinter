const fs = require('fs');
const os = require('os');
const path = require('path');
const consola = require('consola');
const fileLinter = require('../../src/filelinter');
const { createSuccessResponse } = require('./mockresponse');

describe('File linter with mocked API', () => {
    let fetch;
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetch = jest.fn();
        global.fetch = fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
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

    it('writes to options.output instead of overwriting the input file', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        const inputPath = 'test/resources/filter.txt';
        const originalInput = fs.readFileSync(inputPath, 'utf8');
        const outputPath = path.join(os.tmpdir(), `filter.out.${process.pid}.${Date.now()}.txt`);

        try {
            const options = { auto: true, ignoreDomains: new Set(), output: outputPath };
            const fileResult = await fileLinter.lintFile(inputPath, options);
            await fileLinter.applyFileChanges(inputPath, fileResult, options);

            expect(fs.existsSync(outputPath)).toBe(true);
            const written = fs.readFileSync(outputPath, 'utf8');
            // Output should differ from input (dead-domain lines removed).
            expect(written).not.toEqual(originalInput);
            // Input file must be untouched.
            expect(fs.readFileSync(inputPath, 'utf8')).toEqual(originalInput);
        } finally {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
    });

    it('"Yes to all" flips options.auto so later prompts skip consola.prompt', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        // Start with auto=false so the first prompt actually fires. The first
        // call returns "Yes to all"; any further call would mean the auto
        // short-circuit failed.
        const promptSpy = jest.spyOn(consola, 'prompt').mockImplementationOnce(async () => 'Yes to all');

        try {
            // lintFile asks per-rule. The first rule's prompt returns "Yes to
            // all"; rules 2..N must not call prompt again.
            const options = { auto: false, ignoreDomains: new Set() };
            const fileResult = await fileLinter.lintFile('test/resources/filter.txt', options);

            expect(promptSpy).toHaveBeenCalledTimes(1);
            expect(options.auto).toBe(true);
            expect(fileResult.results).toHaveLength(4);
        } finally {
            promptSpy.mockRestore();
        }
    });

    it('"No to all" flips options.show so later prompts skip consola.prompt', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        const promptSpy = jest.spyOn(consola, 'prompt').mockImplementationOnce(async () => 'No to all');

        try {
            const options = { auto: false, ignoreDomains: new Set() };
            const fileResult = await fileLinter.lintFile('test/resources/filter.txt', options);

            // Prompt is called exactly once; the remaining three rules
            // auto-decline via the show short-circuit. lintFile returns null
            // because no results were confirmed, which is the same as a
            // file the user declined every fix on.
            expect(promptSpy).toHaveBeenCalledTimes(1);
            expect(options.show).toBe(true);
            expect(fileResult).toBeNull();
        } finally {
            promptSpy.mockRestore();
        }
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
