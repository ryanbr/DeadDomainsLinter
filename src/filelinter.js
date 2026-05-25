/* eslint-disable no-await-in-loop */
const fs = require('fs');
const consola = require('consola');
// eslint-disable-next-line import/no-unresolved
const consolaUtils = require('consola/utils');
const agtree = require('@adguard/agtree');
const linter = require('./linter');

const DEFAULT_CONCURRENT = 10;

/**
 * Represents options for the linter.
 *
 * @typedef {object} FileLintOptions
 *
 * @property {boolean} show - If true, the linter will only show suggested
 * changes, but will not confirm them.
 * @property {boolean} auto - If true, the linter will automatically count all
 * suggested changes as confirm.
 * @property {boolean} useDNS - If true, the linter doublecheck results received
 * from the urlfilter web service with a DNS query.
 * @property {boolean} commentOut - If true, the linter will suggest commenting
 * a rule out instead of removing it.
 * @property {number} concurrent - Number of concurrent processes.
 * @property {Array<string>} deadDomains - Pre-defined list of dead domains. If
 * it is specified, skip all other checks.
 * @property {Set<string>} ignoreDomains - Set of domains to ignore.
 * @property {string} [output] - If set, write the modified filter list to this
 * path instead of overwriting the input file.
 */

/**
 * Helper function that checks the "automatic" flag first before asking user.
 *
 * @param {string} message - Question to ask the user in the prompt.
 * @param {FileLintOptions} options - Configuration for this linter run.
 * @returns {Promise<boolean>} True if the user confirmed the action, false
 * otherwise.
 */
async function confirm(message, options) {
    if (options.show) {
        consola.info(`${message}: declined automatically`);

        return false;
    }

    if (options.auto) {
        consola.info(`${message}: confirmed automatically`);

        return true;
    }

    const answer = await consola.prompt(message, {
        type: 'select',
        options: ['Yes', 'Yes to all', 'No', 'No to all', 'Exit'],
    });

    if (typeof answer === 'symbol' || answer === 'Exit') {
        consola.info('Cancelled by user');
        process.exit(0);
    }

    if (answer === 'Yes to all') {
        // Flip the options object's auto flag so every subsequent confirm()
        // short-circuits via the auto branch above. cli.js builds a fresh
        // linterOptions per file, so this stays scoped to the current file.
        // eslint-disable-next-line no-param-reassign
        options.auto = true;
        return true;
    }

    if (answer === 'No to all') {
        // Symmetric to "Yes to all": flip the show flag so every subsequent
        // confirm() in this file auto-declines, including the file-level
        // "Apply modifications to the file?" prompt (skipping the write).
        // eslint-disable-next-line no-param-reassign
        options.show = true;
        return false;
    }

    return answer === 'Yes';
}

/**
 * Represents result of processing a rule AST.
 *
 * @typedef {object} AstResult
 *
 * @property {string} line - Text of the rule that's was processed.
 * @property {number} lineNumber - Number of that line.
 * @property {import('./linter').LinterResult} linterResult - Result of linting
 * that line.
 */

/**
 * Process the rule AST from the specified file and returns the linting result
 * or null if nothing needs to be changed.
 *
 * @param {string} file - Path to the file that's being processed.
 * @param {agtree.AnyRule} ast - AST of the rule that's being processed.
 * @param {FileLintOptions} options - Configuration for this linter run.
 * @returns {Promise<AstResult|null>} Returns null if nothing needs to be changed or
 * AstResult if the linter found any issues.
 */
async function processRuleAst(file, ast, options) {
    const line = ast.raws.text;
    const lineNumber = ast.loc.start.line;

    try {
        consola.verbose(`Processing ${file}:${lineNumber}: ${line}`);

        const linterResult = await linter.lintRule(ast, {
            useDNS: options.useDNS,
            concurrent: options.concurrent,
            deadDomains: options.deadDomains,
            ignoreDomains: options.ignoreDomains,
        });

        // If the result is empty, the line can be simply skipped.
        if (!linterResult) {
            return null;
        }

        if (linterResult.suggestedRule === null && options.commentOut) {
            const suggestedRuleText = `! commented out by dead-domains-linter: ${line}`;
            linterResult.suggestedRule = agtree.RuleParser.parse(suggestedRuleText);
        }

        return {
            line,
            lineNumber,
            linterResult,
        };
    } catch (ex) {
        consola.warn(`Failed to process line ${lineNumber} due to ${ex}, skipping it`);

        return null;
    }
}

/**
 * Process the filter list AST and returns a list of changes that are confirmed
 * by the user.
 *
 * @param {string} file - Path to the file that's being processed.
 * @param {agtree.FilterList} listAst - AST of the filter list to process.
 * @param {FileLintOptions} options - Configuration for this linter run.
 *
 * @returns {Promise<Array<AstResult>>} Returns the list of changes that are confirmed.
 */
async function processListAst(file, listAst, options) {
    consola.start(`Analyzing ${listAst.children.length} rules`);

    const totalRules = listAst.children.length;
    let analyzedRules = 0;
    let issuesCount = 0;

    // Promise-based semaphore to limit concurrency without busy-waiting.
    //
    // waitQueue is a head-indexed FIFO: dequeue advances waitHead instead of
    // calling Array.prototype.shift(), which is O(n) and turns the queue into
    // an O(n²) hot spot on large filter lists (every release would memmove the
    // remaining waiters down by one). Consumed slots are nulled out so the
    // resolver closures can be GC'd before the file finishes.
    const waitQueue = [];
    let waitHead = 0;
    let running = 0;

    /**
     * Take a slot in the semaphore. Resolves immediately if there's room,
     * otherwise queues until a release() makes one available.
     *
     * @returns {Promise<void>} Resolves once a slot is held by the caller.
     */
    function acquire() {
        if (running < (options.concurrent || DEFAULT_CONCURRENT)) {
            running += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => { waitQueue.push(resolve); });
    }

    /**
     * Give the caller's slot back, handing it to the next queued waiter if any.
     */
    function release() {
        running -= 1;
        if (waitHead < waitQueue.length) {
            running += 1;
            const next = waitQueue[waitHead];
            waitQueue[waitHead] = undefined;
            waitHead += 1;
            next();
        }
    }

    const processingResults = await Promise.all(listAst.children.map((ast) => {
        return (async () => {
            await acquire();
            try {
                const result = await processRuleAst(file, ast, options);
                if (result !== null) {
                    issuesCount += 1;
                }

                return result;
            } finally {
                analyzedRules += 1;

                if (analyzedRules % 100 === 0 || analyzedRules === totalRules) {
                    const msg = `Analyzed ${analyzedRules}/${totalRules} rules, found ${issuesCount} issues`;
                    process.stdout.write(`\r${msg}`);
                }
                if (analyzedRules === totalRules) {
                    process.stdout.write('\n');
                }

                release();
            }
        })();
    }));

    const results = processingResults.filter((res) => res !== null);

    consola.success(`Found ${results.length} issues`);

    // Sort the results by line number in ascending order.
    results.sort((a, b) => a.lineNumber - b.lineNumber);

    // Now ask the user whether the changes are allowed.
    const allowedResults = [];
    for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const { suggestedRule, deadDomains } = result.linterResult;
        const suggestedRuleText = suggestedRule === null ? '' : suggestedRule.raws.text;

        consola.info(`Found dead domains in a rule: ${deadDomains.join(', ')}`);
        consola.info(consolaUtils.colorize('red', `- ${result.lineNumber}: ${result.line}`));
        consola.info(consolaUtils.colorize('green', `+ ${result.lineNumber}: ${suggestedRuleText}`));

        const confirmed = await confirm('Apply suggested fix?', options);
        if (confirmed) {
            allowedResults.push(result);
        }
    }

    return allowedResults;
}

/**
 * Result of linting the file.
 *
 * @typedef {object} FileResult
 *
 * @property {agtree.FilterList} listAst - AST of the filter list.
 * @property {Array<AstResult>} results - List of changes to apply to the filter
 * list.
 */

/**
 * Lints the specified file and returns the resulting list of changes and
 * the original file AST.
 *
 * @param {string} file - Path to the file that the program should process.
 * @param {FileLintOptions} options - Configuration for this linter run.
 * @returns {Promise<FileResult|null>} Object with the file linting result or
 * null if there is nothing to change.
 */
async function lintFile(file, options) {
    const content = fs.readFileSync(file, 'utf8');

    // Parsing the whole filter list.
    const listAst = agtree.FilterListParser.parse(content);

    if (!listAst.children || listAst.children.length === 0) {
        consola.info(`No rules found in ${file}`);

        return null;
    }

    const results = await processListAst(file, listAst, options);

    if (results.length === 0) {
        consola.info(`No changes to ${file}`);

        return null;
    }

    return {
        listAst,
        results,
    };
}

/**
 * Asks for the user permission to change the file.
 *
 * @param {string} file - Path to the file being analyzed.
 * @param {FileResult} fileResult - Result of linting the file.
 * @param {FileLintOptions} options - Configuration for this linter run.
 * @returns {Promise<boolean>} True if the user confirmed the changes.
 */
async function confirmFileChanges(file, fileResult, options) {
    const { results } = fileResult;

    // Count the number of lines that are to be removed.
    const cntRemove = results.reduce((cnt, res) => {
        return res.linterResult.suggestedRule === null ? cnt + 1 : cnt;
    }, 0);
    const cntModify = results.reduce((cnt, res) => {
        return res.linterResult.suggestedRule !== null ? cnt + 1 : cnt;
    }, 0);

    const summaryMsg = `${consolaUtils.colorize('bold', `Summary for ${file}:`)}\n`
        + `${cntRemove} line${cntRemove !== 1 ? 's' : ''} will be removed.\n`
        + `${cntModify} line${cntModify !== 1 ? 's' : ''} will be modified.`;

    consola.box(summaryMsg);

    const confirmed = await confirm('Apply modifications to the file?', options);

    return confirmed;
}

/**
 * Mutates fileResult.listAst by removing/replacing rules per fileResult.results
 * and returns the serialized filter list. Pure: no prompts, no I/O.
 *
 * @param {FileResult} fileResult - Result of linting the file.
 * @returns {string} The new filter list contents.
 */
function buildNewContents(fileResult) {
    const { listAst, results } = fileResult;

    // Sort result by lineNumber descending so that we could use it for the
    // original array modification.
    results.sort((a, b) => b.lineNumber - a.lineNumber);

    // Go through the results array in and either remove or modify the
    // lines.
    for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const lineIdx = result.lineNumber - 1;

        if (result.linterResult.suggestedRule === null) {
            listAst.children.splice(lineIdx, 1);
        } else {
            listAst.children[lineIdx] = result.linterResult.suggestedRule;
        }
    }

    // Generate a new filter list contents, use raw text when it's
    // available in a rule AST.
    return agtree.FilterListParser.generate(listAst, true);
}

/**
 * Applies confirmed changes to the file.
 *
 * @param {string} file - Path to the file.
 * @param {FileResult} fileResult - Result of linting the file.
 * @param {FileLintOptions} options - Configuration for this linter run.
 */
async function applyFileChanges(file, fileResult, options) {
    const confirmed = await confirmFileChanges(file, fileResult, options);

    if (!confirmed) {
        consola.info(`Skipping file ${file}`);

        return;
    }

    const outputPath = options.output || file;
    consola.info(`Applying modifications to ${outputPath}`);

    const newContents = buildNewContents(fileResult);

    // Write the filter list to disk: --output if set, otherwise overwrite the input.
    fs.writeFileSync(outputPath, newContents);
}

module.exports = {
    lintFile,
    applyFileChanges,
    buildNewContents,
};
