#!/usr/bin/env node
import { createSystemOps, runReleaseCycle } from '../src/v2/vps-release-runtime.mjs';

const args = new Set(process.argv.slice(2));
const bootstrap = args.has('--bootstrap');
const runHygiene = !args.has('--update-only');
const origin = process.env.INVOCATION_ID ? 'timer' : 'manual';

const ops = createSystemOps();
const audit = await runReleaseCycle({ ops, runHygiene, bootstrap, origin });
console.log(JSON.stringify(audit, null, 2));

const success = ['already-current', 'promoted'].includes(audit.decision) && (!runHygiene || audit.gates.hygiene === true);
process.exitCode = success ? 0 : 1;
