const STORAGE_KEY = "symphonia_patterns";

interface StoredPattern {
  id: number;
  name: string;
  preset: string;
  data: string;
  updatedAt: string; // ISO string
}

function readAll(): StoredPattern[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredPattern[]) : [];
  } catch {
    return [];
  }
}

function writeAll(patterns: StoredPattern[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(patterns));
}

export function listPatterns(): Promise<{
  patterns: { id: number; name: string; preset: string; updatedAt: Date }[];
}> {
  const all = readAll();
  const patterns = all
    .map(p => ({ id: p.id, name: p.name, preset: p.preset, updatedAt: new Date(p.updatedAt) }))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return Promise.resolve({ patterns });
}

export function getPattern(id: number): Promise<{
  pattern: { id: number; name: string; preset: string; data: string } | null;
}> {
  const found = readAll().find(p => p.id === id);
  if (!found) return Promise.resolve({ pattern: null });
  return Promise.resolve({
    pattern: { id: found.id, name: found.name, preset: found.preset, data: found.data },
  });
}

export function savePattern(args: {
  name: string;
  preset: string;
  data: string;
  id?: number;
}): Promise<{ id: number; updated: boolean }> {
  const all = readAll();
  const now = new Date().toISOString();

  if (args.id !== undefined) {
    const idx = all.findIndex(p => p.id === args.id);
    const existing = all[idx];
    if (idx !== -1 && existing !== undefined) {
      all[idx] = { ...existing, name: args.name, preset: args.preset, data: args.data, updatedAt: now };
      writeAll(all);
      return Promise.resolve({ id: args.id, updated: true });
    }
  }

  const id = Date.now();
  all.push({ id, name: args.name, preset: args.preset, data: args.data, updatedAt: now });
  writeAll(all);
  return Promise.resolve({ id, updated: false });
}

export function deletePattern(id: number): Promise<{ success: boolean }> {
  writeAll(readAll().filter(p => p.id !== id));
  return Promise.resolve({ success: true });
}
