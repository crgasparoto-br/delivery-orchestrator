import fs from 'node:fs';
const file = 'scripts/delivery-v2-r5-patch.mjs';
let text = fs.readFileSync(file, 'utf8');
const oldLine = `    text = once(text, "materialWorkerIdentity: plan.implementation.workflow, materialWorkerProvider: plan.implementation.provider", "materialWorkerIdentity: initialWorkerIdentity, materialWorkerProvider: initialWorkerProvider", file + ': initial persisted producer');`;
const newLine = `    text = once(text, "  await persist({ nextAction: 'observe-ci', workerRunId: worker.id, workerDispatchNonce: initialDispatchNonce, materialWorkerRunId: worker.id, materialWorkerIdentity: plan.implementation.workflow, materialWorkerProvider: plan.implementation.provider });", "  await persist({ nextAction: 'observe-ci', workerRunId: worker.id, workerDispatchNonce: initialDispatchNonce, materialWorkerRunId: worker.id, materialWorkerIdentity: initialWorkerIdentity, materialWorkerProvider: initialWorkerProvider });", file + ': initial persisted producer');`;
if (!text.includes(oldLine)) throw new Error('r5 producer patcher anchor missing');
text = text.replace(oldLine, newLine);
fs.writeFileSync(file, text);
