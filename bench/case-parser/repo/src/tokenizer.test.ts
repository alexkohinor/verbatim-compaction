import { parse } from './parser.js';
export const cases = ['trailing comma', 'nested object', 'empty object'];
export default function run() { return parse([]); }
