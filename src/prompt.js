import { createInterface } from 'node:readline/promises';

/**
 * Asks a yes/no question on the terminal. The default is yes: anything but an
 * answer starting with "n" confirms, so an empty line (Enter) means yes.
 * @param {string} question  include the hint, e.g. "Install it now? [Y/n] "
 * @param {{ output?: NodeJS.WritableStream }} [opts]  where the question is written (default stdout)
 * @returns {Promise<boolean>}
 */
export async function confirm(question, { output = process.stdout } = {}) {
  const rl = createInterface({ input: process.stdin, output });
  try {
    return !/^n/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
