// SmartBox unlock code. The backend shows it to the customer; the box (Arduino) checks it at the
// keypad on its own, without internet. Both sides must use exactly the same formula:
//
//   code = ((lockerUserId + dayOfMonth) % 10000) + SECRET
//
// dayOfMonth comes from the box's RTC, which is set to Egypt local time, so the server uses
// the same time zone. SECRET must equal SECRET_KEY in the Arduino sketch (LOCKER_CODE_SECRET in .env).
// The code changes every day at midnight Egypt time. See docs/SMARTBOX_INTEGRATION.md.

const SECRET = Number(process.env.LOCKER_CODE_SECRET) || 7257;
const TIME_ZONE = process.env.LOCKER_TIME_ZONE || 'Africa/Cairo';

const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric' });

// Day of the month (1–31) in the box's time zone
export function dayOfMonth(date = new Date()) {
  return Number(dayFormat.format(date));
}

export function generateLockerCode(userId, date = new Date()) {
  return ((Number(userId) + dayOfMonth(date)) % 10000) + SECRET;
}

// Used by the online check (/returns/validate-code). Accepts today's code and yesterday's,
// so a customer who opened the app just before midnight is not locked out.
export function validateLockerCode(userId, enteredCode, date = new Date()) {
  const yesterday = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return [date, yesterday].some(
    (day) => String(enteredCode).trim() === String(generateLockerCode(userId, day))
  );
}

// 3-digit ID the customer types on the keypad before the code
export function generateLockerUserId() {
  return String(Math.floor(100 + Math.random() * 900));
}
