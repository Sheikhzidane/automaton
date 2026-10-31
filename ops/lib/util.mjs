// Small, dependency-free helpers shared by the operations engine.
// Everything that touches the filesystem writes atomically (temp file,
// then rename) so a crash mid-write never leaves half a JSON file.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function newId(prefix = 'run') {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    // JSON.parse's message quotes the text around the fault, which for a
    // people-edited file can be personal data. Report the place only.
    const at = /position (\d+)/.exec(String(err?.message ?? ''));
    throw new Error(`Corrupt JSON in ${path}${at ? ` near character ${at[1]}` : ''}`);
  }
}

export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function appendJsonl(path, value) {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Corrupt line ${i + 1} in ${path}`);
      }
    });
}

// Keeps a JSONL history file from growing without bound.
export function trimJsonl(path, keep) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= keep) return;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${lines.slice(-keep).join('\n')}\n`);
  renameSync(tmp, path);
}

export function iso(date) {
  return new Date(date).toISOString();
}

export function minutes(n) {
  return n * 60 * 1000;
}

export function londonDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function monthKey(date) {
  return iso(date).slice(0, 7);
}

export function p(stateDir, ...parts) {
  return join(stateDir, ...parts);
}

// Anything that looks like an email address or a phone number. Used to
// keep personal data out of records that should only hold pseudonyms.
export function looksEmail(text) {
  return typeof text === 'string' && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text);
}

export function looksPersonal(text) {
  if (typeof text !== 'string') return false;
  if (looksEmail(text)) return true;
  if (/(\+?\d[\d\s().-]{8,}\d)/.test(text)) return true;
  return false;
}
