
const SECRET_KEY = 1468;

/**
 * format: DDMM (ex: 13 June → 1306)
 */
export function getDayCode(date = new Date()) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  console.log("day", day);

  return parseInt(day); // 1306

}
// 13
export function generateLockerCode(userId, date = new Date()) {
  const n = Number(userId);
  const day = getDayCode(date);


  return n + SECRET_KEY + day; // For testing only (no modulo, no offset)
}


export function validateLockerCode(userId, enteredCode, date = new Date()) {
  return (
    String(enteredCode) === generateLockerCode(userId, date)
  );
}


export function generateLockerUserId() {
  return String(Math.floor(100 + Math.random() * 900));
}





// #include < Wire.h >
//   #include "RTClib.h"

// RTC_DS3231 rtc;

// // نفس السر اللي في السيرفر
// const long SECRET_KEY = 146818;

// // تحويل التاريخ إلى رقم (DDMM)
// int getDayCode(int day, int month) {
//   return (day * 100) + month;
// }

// // نفس المعادلة بتاعة السيرفر
// int generateLockerCode(long userId, int day, int month) {
//   long dayCode = getDayCode(day, month);

//   long raw = ((userId ^ SECRET_KEY) + dayCode) % 9000;

//   return (raw + 1000);
// }

// void setup() {
//   Serial.begin(9600);

//   if (!rtc.begin()) {
//     Serial.println("RTC not found");
//     while (1);
//   }

//   // لو الساعة مش متظبطة أول مرة فقط
//   // rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));

//   Serial.println("System Ready");
// }

// void loop() {

//   // مثال: إدخال يدوي (بدل keypad / serial / RFID)
//   long userId = 567564;
//   int enteredCode = 2696;

//   DateTime now = rtc.now();

//   int day = now.day();
//   int month = now.month();

//   int expectedCode = generateLockerCode(userId, day, month);

//   Serial.print("Today: ");
//   Serial.print(day);
//   Serial.print("/");
//   Serial.println(month);

//   Serial.print("Expected Code: ");
//   Serial.println(expectedCode);

//   if (enteredCode == expectedCode) {
//     Serial.println("ACCESS GRANTED - OPEN LOCKER");
//     // digitalWrite(RELAY_PIN, HIGH);
//   } else {
//     Serial.println("ACCESS DENIED");
//     // digitalWrite(RELAY_PIN, LOW);
//   }

//   delay(5000); // إعادة المحاولة كل 5 ثواني
// }