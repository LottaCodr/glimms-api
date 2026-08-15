/**
 * TEMPORARY CI diagnostic (removed before merge).
 * Prints each failed test as a GitHub Actions `::error::` annotation so the
 * failure is readable via the check-runs API when raw logs are unavailable.
 */
module.exports = class GhaFailureReporter {
  onRunComplete(_contexts, results) {
    if (!process.env.GITHUB_ACTIONS) return;
    for (const suite of results.testResults) {
      for (const t of suite.testResults) {
        if (t.status !== 'failed') continue;
        const file = suite.testFilePath.split('/').pop();
        const msg = (t.failureMessages || [])
          .join('\n')
          .slice(0, 2000)
          .replace(/%/g, '%25')
          .replace(/\r/g, '%0D')
          .replace(/\n/g, '%0A');
        console.log(`::error title=${file} :: ${t.fullName}: ${msg}`);
      }
    }
  }
};
