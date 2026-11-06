import { toLocalParts } from '../clinics/hours.ts';
import type { AppointmentStatus } from '../db.ts';

type Row = {
  id: string;
  clinic_id: string | null;
  clinic_name: string;
  pet_id: string;
  pet_name: string;
  species: string;
  breed: string | null;
  pet_age: string | null;
  reason: string;
  note: string | null;
  starts_at: Date;
  status: AppointmentStatus;
  cancelled_by: 'owner' | 'vet' | null;
  vet_note: string | null;
};

export const APPOINTMENT_COLUMNS = [
  'appointments.id',
  'appointments.clinic_id',
  'appointments.clinic_name',
  'appointments.pet_id',
  'appointments.pet_name',
  'appointments.species',
  'appointments.breed',
  'appointments.pet_age',
  'appointments.reason',
  'appointments.note',
  'appointments.starts_at',
  'appointments.status',
  'appointments.cancelled_by',
  'appointments.vet_note',
  'appointments.responded_at',
  // Bu iki alan yalnızca sahibin kendisine ve randevunun kliniğine döner.
  'appointments.owner_name',
  'appointments.owner_phone',
] as const;

// Saati geçmiş ve cevaplanmamış istek "süresi doldu" görünür.
export function appointmentJson<T extends Row>(row: T, now = new Date()) {
  const isExpired = row.status === 'pending' && row.starts_at <= now;
  return {
    ...row,
    ...toLocalParts(row.starts_at),
    status: isExpired ? ('expired' as const) : row.status,
  };
}
