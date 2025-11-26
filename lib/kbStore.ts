// lib/kbStore.ts
import fs from 'fs/promises';
import path from 'path';

/**
 * A simple knowledge base store that persists data to a JSON file on disk.
 *
 * In a production environment you could swap this out for an object store
 * such as Vercel Blob or your favourite database. The file path defaults
 * to `/tmp/kb.json` but can be overridden via the `KB_PATH` environment
 * variable. The stored schema is an array of objects with the shape:
 * `{ question: string, answers: string[], embedding: number[] }`.
 */

const DEFAULT_KB_PATH = '/tmp/kb.json';

function getKbPath(): string {
  return process.env.KB_PATH || DEFAULT_KB_PATH;
}

export interface KBItem {
  question: string;
  answers: string[];
  embedding: number[];
}

/**
 * Load all knowledge base items from disk. If the file does not exist or
 * cannot be parsed it returns an empty array.
 */
export async function loadKb(): Promise<KBItem[]> {
  const kbPath = getKbPath();
  try {
    const data = await fs.readFile(kbPath, 'utf8');
    const items = JSON.parse(data);
    if (Array.isArray(items)) {
      return items as KBItem[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Persist the provided knowledge base items to disk. The directory is
 * automatically created if it does not exist. Writes are atomic.
 */
export async function saveKb(items: KBItem[]): Promise<void> {
  const kbPath = getKbPath();
  const dir = path.dirname(kbPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${kbPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmpPath, kbPath);
}
