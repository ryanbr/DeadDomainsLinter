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

    it('"Yes to all" also auto-confirms the file-level prompt and writes the file', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        // First (and only expected) prompt returns 'Yes to all'. If the
        // file-level prompt ever reaches consola.prompt the spy goes back
        // to the real implementation and the test hangs (or fails the
        // toHaveBeenCalledTimes assertion).
        const promptSpy = jest.spyOn(consola, 'prompt').mockImplementationOnce(async () => 'Yes to all');

        const inputPath = 'test/resources/filter.txt';
        const originalInput = fs.readFileSync(inputPath, 'utf8');
        const outputPath = path.join(os.tmpdir(), `filter.yta.${process.pid}.${Date.now()}.txt`);

        try {
            const options = { auto: false, ignoreDomains: new Set(), output: outputPath };
            const fileResult = await fileLinter.lintFile(inputPath, options);
            await fileLinter.applyFileChanges(inputPath, fileResult, options);

            // One prompt total across both calls — the per-rule one that
            // returned "Yes to all". The file-level prompt must have hit
            // the auto-confirm short-circuit.
            expect(promptSpy).toHaveBeenCalledTimes(1);
            expect(options.auto).toBe(true);
            // applyFileChanges wrote to the output path (dead lines removed).
            expect(fs.existsSync(outputPath)).toBe(true);
            expect(fs.readFileSync(outputPath, 'utf8')).not.toEqual(originalInput);
            // Input file untouched.
            expect(fs.readFileSync(inputPath, 'utf8')).toEqual(originalInput);
        } finally {
            promptSpy.mockRestore();
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
    });

    it('"No to all" mid-file auto-declines the file-level prompt and writes nothing', async () => {
        fetch.mockResolvedValue(createSuccessResponse(
            ['example.notexisting', 'anotherdeaddomain.examplee'],
            ['example.org'],
        ));

        // Confirm the first two rules normally, then "No to all" on the
        // third. The fourth rule auto-declines, and the file-level prompt
        // also auto-declines — total prompts = 3.
        const promptSpy = jest.spyOn(consola, 'prompt')
            .mockImplementationOnce(async () => 'Yes')
            .mockImplementationOnce(async () => 'Yes')
            .mockImplementationOnce(async () => 'No to all');

        const inputPath = 'test/resources/filter.txt';
        const originalInput = fs.readFileSync(inputPath, 'utf8');
        const outputPath = path.join(os.tmpdir(), `filter.nta.${process.pid}.${Date.now()}.txt`);

        try {
            const options = { auto: false, ignoreDomains: new Set(), output: outputPath };
            const fileResult = await fileLinter.lintFile(inputPath, options);
            // lintFile returns the two pre-"No to all" confirmations; not null.
            expect(fileResult).not.toBeNull();
            expect(fileResult.results).toHaveLength(2);

            await fileLinter.applyFileChanges(inputPath, fileResult, options);

            expect(promptSpy).toHaveBeenCalledTimes(3);
            expect(options.show).toBe(true);
            // File-level confirm declined → no write happened.
            expect(fs.existsSync(outputPath)).toBe(false);
            // Input file untouched.
            expect(fs.readFileSync(inputPath, 'utf8')).toEqual(originalInput);
        } finally {
            promptSpy.mockRestore();
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
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
