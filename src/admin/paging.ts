import { z } from 'zod';

export const PAGE_SIZE = 50;
export const Offset = z.coerce.number().int().min(0).max(1_000_000).default(0);

// Sorgu bir satır fazla ister: fazlası geldiyse "Daha fazla göster" düğmesi çıkar.
export function pageOf<T>(rows: T[]) {
  return { items: rows.slice(0, PAGE_SIZE), has_more: rows.length > PAGE_SIZE };
}
