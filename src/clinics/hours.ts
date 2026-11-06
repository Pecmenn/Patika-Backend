import type { Db, DayHours } from '../db.ts';

// Türkiye yaz-kış saati uygulamıyor, ilk sürüm yalnızca Türkiye için: tüm klinik saatleri UTC+3.
const TURKEY_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Sahip en fazla bu kadar gün sonrasına randevu isteyebilir.
export const BOOKING_WINDOW_DAYS = 60;

export function toInstant(date: string, time: string) {
  return new Date(`${date}T${time}:00+03:00`);
}

// Telefonlara klinik saatiyle gider: ekranda da ziyaret kaydında da aynı görünür.
export function toLocalParts(instant: Date) {
  const iso = new Date(instant.getTime() + TURKEY_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

// Pazartesi 0, pazar 6.
function weekdayIndex(date: string) {
  return (new Date(`${date}T12:00:00+03:00`).getUTCDay() + 6) % 7;
}

function toMinutes(time: string) {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function toTime(minutes: number) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// Çalışma saatlerine göre o günün randevu saatleri. Son randevu kapanıştan önce bitmeli.
export function slotsOfDay(hours: DayHours[], date: string, slotMinutes: number) {
  const day = hours[weekdayIndex(date)];
  if (!day) {
    return [];
  }
  const times: string[] = [];
  const close = toMinutes(day.close);
  for (let start = toMinutes(day.open); start + slotMinutes <= close; start += slotMinutes) {
    times.push(toTime(start));
  }
  return times;
}

function isWithinBookingWindow(date: string, now: Date) {
  const today = toLocalParts(now).date;
  const last = toLocalParts(new Date(now.getTime() + BOOKING_WINDOW_DAYS * DAY_MS)).date;
  return date >= today && date <= last;
}

// O gün için istek gönderilebilecek saatler: çalışma saati içinde, geçmemiş ve onaylı randevusu olmayan.
export async function freeTimes(
  db: Db,
  clinic: { id: string; hours: DayHours[]; slot_minutes: number },
  date: string,
  now = new Date(),
) {
  if (!isWithinBookingWindow(date, now)) {
    return [];
  }
  const times = slotsOfDay(clinic.hours, date, clinic.slot_minutes);
  if (times.length === 0) {
    return [];
  }
  const dayStart = toInstant(date, '00:00');
  const taken = await db
    .selectFrom('appointments')
    .select('starts_at')
    .where('clinic_id', '=', clinic.id)
    .where('status', '=', 'confirmed')
    .where('starts_at', '>=', dayStart)
    .where('starts_at', '<', new Date(dayStart.getTime() + DAY_MS))
    .execute();
  const takenTimes = new Set(taken.map(({ starts_at: startsAt }) => toLocalParts(startsAt).time));
  return times.filter((time) => !takenTimes.has(time) && toInstant(date, time) > now);
}
