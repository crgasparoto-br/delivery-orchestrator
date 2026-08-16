import { readFile } from 'node:fs/promises';

function render(text, values) {
  return text.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_, key) => String(values[key] ?? ''));
}

export async function loadPrompt(file, values) {
  return render(await readFile(file, 'utf8'), values);
}
