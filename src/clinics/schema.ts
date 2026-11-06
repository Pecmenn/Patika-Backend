import { z } from 'zod';

export const SPECIES = ['cat', 'dog', 'rabbit', 'bird'] as const;
export const SERVICES = [
  'exam',
  'vaccine',
  'surgery',
  'dental',
  'lab',
  'imaging',
  'grooming',
  'emergency',
] as const;
const SLOT_MINUTES = [15, 20, 30, 45, 60];

export const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const Phone = z.string().trim().regex(/^[0-9+() -]{7,24}$/);

const Text = (max: number) => z.string().trim().min(1).max(max);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

const Day = z
  .object({ open: Time, close: Time })
  .refine(({ open, close }) => open < close)
  .nullable();

export const ClinicBody = z.object({
  name: Text(80),
  vet_name: Text(80),
  license_no: Text(40),
  phone: Phone,
  address: Text(200),
  area: Text(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // Pazartesiden pazara. En az bir gün açık olmalı, yoksa randevu alınamaz.
  hours: z
    .array(Day)
    .length(7)
    .refine((days) => days.some(Boolean)),
  slot_minutes: z.number().refine((value) => SLOT_MINUTES.includes(value)),
  species: z.array(z.enum(SPECIES)).min(1).max(SPECIES.length),
  services: z.array(z.enum(SERVICES)).max(SERVICES.length),
  description: OptionalText(600),
  // Uygulama bu adresi tarayıcıda açar: yalnızca web adresi kabul edilir.
  website: OptionalText(200).refine((value) => value === null || /^https?:\/\/\S+$/i.test(value)),
  instagram: OptionalText(60).refine((value) => value === null || /^@?[A-Za-z0-9._]{1,30}$/.test(value)),
});

export const IdParams = z.object({ id: z.uuid() });
