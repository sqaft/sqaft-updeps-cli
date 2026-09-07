import { loadConfig } from '../config.js';
import { formatAsciiGraph } from '../graph.js';

export function commandGraph() {
  const config = loadConfig();
  console.log(formatAsciiGraph(config));
}
