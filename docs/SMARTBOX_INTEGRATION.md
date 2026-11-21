# ربط صندوق الإرجاع (SmartBox) بالسيرفر

الملف ده لمسؤول الهاردوير: الصندوق بيعمل إيه، والتعديلات المطلوبة في كود الأردوينو، وكود الـ ESP32-CAM، وإزاي نجرّب.

## الفكرة

```
العميل في الأبلكيشن                الصندوق                                السيرفر (الباك إند)
──────────────────                ─────────────────────────────          ─────────────────────
بيعمل طلب إرجاع  ───────────────►                                         بيدّيله Locker ID (3 أرقام)
بيشوف الكود في الأبلكيشن                                                    + كود فتح (بيتغير كل يوم)

                                   Arduino Uno:
                                   1. العميل يكتب الـ ID والكود
                                   2. الأردوينو يحسب الكود بنفسه ويقارن
                                   3. يفتح الباب ويستنى الميزان
                                   4. لما يلاقي وزن، يبعت للكاميرا على Serial:
                                        ID:583
                                        WEIGHT:350.25
                                        CAPTURE
                                   ESP32-CAM:
                                   5. تصوّر وتبعت الصورة ─────────────────► POST /camera/upload
                                                                           يلاقي المرتجع بالـ ID،
                                                                           يحفظ الصورة والوزن،
                                                                           يعلّم المرتجع "completed"،
                                                                           ويراجع الصورة والوزن على المنتج
```

الأردوينو مش محتاج إنترنت؛ الكاميرا بس هي اللي محتاجة واي فاي.

## ١. معادلة الكود (لازم تبقى نفسها في الأردوينو والسيرفر)

```
code = ((ID + اليوم من الشهر) % 10000) + 7257
```

- السيرفر بقى بيحسبها بنفس الطريقة بالظبط، بتوقيت مصر. يعني الكود اللي بيظهر في الأبلكيشن هو اللي الصندوق هيقبله.
- `7257` هو `SECRET_KEY` في الأردوينو. لو غيرته، غيّر `LOCKER_CODE_SECRET` في ملف `.env` بتاع الباك إند لنفس الرقم.
- الكود بيتغير كل يوم الساعة ١٢ بالليل، فالعميل يفتح الأبلكيشن يوم ما هيروح الصندوق.

## ٢. التعديلات المطلوبة في كود الأردوينو

### أ) ابعت الـ ID للكاميرا قبل الصورة (مهم)
في `checkWeight()`، استبدل سطور الإرسال للكاميرا بدول:

```cpp
      // الكاميرا محتاجة الـ ID عشان السيرفر يعرف الصورة دي لأنهي مرتجع
      Serial.print("ID:");
      Serial.println(enteredID);

      Serial.print("WEIGHT:");
      Serial.println(weight);

      Serial.println("CAPTURE");
```

الترتيب مهم: `ID` ثم `WEIGHT` ثم `CAPTURE` في الآخر. أي سطر تاني بيطبعه الأردوينو (زي `Item Weight: ...`) الكاميرا بتتجاهله.

### ب) متضبطش الساعة مع كل تشغيل (مهم)
دلوقتي `rtc.adjust(...)` بتشتغل في كل `setup()`، فبعد أي قطع كهربا الساعة بترجع لوقت رفع الكود، والتاريخ يبقى غلط والأكواد كلها تبوظ. خليها كده:

```cpp
  rtc.begin();

  // اضبط الساعة بس لو بطارية الـ RTC فصلت (أول مرة أو بعد تغيير البطارية)
  if (rtc.lostPower()) {
    rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }
```

ارفع الكود من كمبيوتر ساعته على **توقيت مصر**، عشان الـ RTC يتضبط على نفس توقيت السيرفر.

### ج) الباقي زي ما هو
المعادلة و`SECRET_KEY = 7257` والكيباد والميزان والسيرفو مش محتاجين تغيير.

## ٣. التوصيل بين الأردوينو والـ ESP32-CAM

| من | إلى | ملاحظة |
|---|---|---|
| Arduino pin 1 (TX) | ESP32-CAM `U0R` (GPIO3) | **من خلال مقسم جهد**: مقاومة 1k من TX للـ U0R، ومقاومة 2k من U0R للـ GND (الأردوينو 5V والـ ESP32 بتستحمل 3.3V بس) |
| Arduino GND | ESP32-CAM GND | لازم GND مشترك |
| — | — | **متوصلش** TX بتاع الـ ESP32 بـ pin 0 في الأردوينو؛ مش محتاجينه وهيبوّظ رفع الكود على الأردوينو |

- السرعة على الناحيتين `9600`.
- الأفضل تغذّي الـ ESP32-CAM من مصدر 5V منفصل (500mA على الأقل) مع GND مشترك؛ الواي فاي والفلاش بيسحبوا تيار عالي.

## ٤. كود الـ ESP32-CAM

### لو معاك الكود الحالي (اللي بيقرا `ID:` و`WEIGHT:` و`CAPTURE`): 3 تعديلات بس

**أ) عنوان السيرفر:** السيرفر بقى على اللابتوب، مش على Vercel:
```cpp
const char* serverUrl = "http://192.168.1.157:3001/camera/upload";   // IP اللابتوب على الشبكة
```

**ب) في `loop()`، جوه `CAPTURE`: متطلبش `next-return`**، الـ ID جاي من الأردوينو خلاص:
```cpp
    else if (msg == "CAPTURE") {
      if (currentID == "") {
        Serial.println("No ID received from Arduino");
        return;
      }
      sendImage();
      currentID = "";
    }
```
(تقدر تمسح دالة `getNextReturnId()` و`#include <ArduinoJson.h>`، مبقوش مستخدمين.)

**ج) في `sendImage()`: ابعت الـ ID اللي اتكتب على الكيباد** بدل `X-Return-Id`:
```cpp
  http.addHeader("X-Locker-User-Id", currentID);
```
وامسح سطر `http.addHeader("X-Return-Id", currentID);`.

الباقي (الكاميرا وتحويل الصورة لـ JPEG والهيدرز التانية) زي ما هو.

### أو كود كامل من الأول (بوردة AI Thinker)

غيّر القيم اللي في أول الكود بس. المفتاح `DEVICE_KEY` لازم يبقى نفس قيمة `DEVICE_API_KEY` في ملف `.env` بتاع الباك إند (خده من صاحب الباك إند، ومترفعهوش على GitHub).

```cpp
// Cartify SmartBox — ESP32-CAM (AI Thinker)
// Waits for the Arduino on Serial (ID:, WEIGHT:, CAPTURE), takes a photo and uploads it to the server.
#include <WiFi.h>
#include <HTTPClient.h>
#include "esp_camera.h"

// ===== غيّر دول =====
const char* WIFI_SSID     = "WIFI_NAME";
const char* WIFI_PASSWORD = "WIFI_PASSWORD";
const char* SERVER_URL    = "http://192.168.1.10:3001";   // IP الكمبيوتر اللي شغال عليه الباك إند
const char* DEVICE_KEY    = "PUT_DEVICE_API_KEY_HERE";    // = DEVICE_API_KEY في .env
const char* BOX_ID        = "box-001";                    // اسم الصندوق، يظهر في لوحة الأدمن
const char* FIRMWARE      = "1.0.0";

// ===== AI Thinker ESP32-CAM pins =====
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22
#define FLASH_LED        4   // اللمبة اللي على البوردة (الصندوق من جوه ضلمة)

String lockerId = "";
float weight = 0;

bool startCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk  = XCLK_GPIO_NUM;
  config.pin_pclk  = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href  = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;   // في نسخ ESP32 القديمة اسمها pin_sscb_sda
  config.pin_sccb_scl = SIOC_GPIO_NUM;   // في نسخ ESP32 القديمة اسمها pin_sscb_scl
  config.pin_pwdn  = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = FRAMESIZE_VGA;   // 640x480 كفاية للمراجعة وسريعة في الرفع
  config.jpeg_quality = 12;              // رقم أقل = جودة أعلى وحجم أكبر
  config.fb_count     = 1;
  return esp_camera_init(&config) == ESP_OK;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
}

void captureAndUpload() {
  if (lockerId.length() == 0) {
    Serial.println("No ID received before CAPTURE, skipping");
    return;
  }
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected");
    return;
  }

  // أول صورة ممكن تكون قديمة من الذاكرة: نصوّر ونرميها، وبعدين نصوّر الصورة الحقيقية
  camera_fb_t* fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  digitalWrite(FLASH_LED, HIGH);
  delay(150);
  fb = esp_camera_fb_get();
  digitalWrite(FLASH_LED, LOW);
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  for (int attempt = 1; attempt <= 3; attempt++) {
    HTTPClient http;
    http.begin(String(SERVER_URL) + "/camera/upload");
    http.setTimeout(20000);
    http.addHeader("Content-Type", "image/jpeg");
    http.addHeader("X-Device-Key", DEVICE_KEY);
    http.addHeader("X-Box-Id", BOX_ID);
    http.addHeader("X-Locker-User-Id", lockerId);
    http.addHeader("X-Weight", String(weight, 2));
    http.addHeader("X-Firmware-Version", FIRMWARE);

    int status = http.POST(fb->buf, fb->len);
    String body = http.getString();
    http.end();
    Serial.printf("Upload attempt %d -> %d %s\n", attempt, status, body.c_str());

    // 200 = تمام. 4xx = في حاجة غلط في الطلب نفسه (مفتاح، ID...) والإعادة مش هتفرق
    if (status == 200 || (status >= 400 && status < 500)) break;
    delay(2000);   // مشكلة شبكة أو سيرفر: نحاول تاني
  }

  esp_camera_fb_return(fb);
  lockerId = "";
  weight = 0;
}

void setup() {
  Serial.begin(9600);                 // نفس سرعة الأردوينو
  pinMode(FLASH_LED, OUTPUT);
  digitalWrite(FLASH_LED, LOW);
  if (!startCamera()) Serial.println("Camera init failed");
  WiFi.mode(WIFI_STA);
  connectWiFi();
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi OK: " + WiFi.localIP().toString() : "WiFi not connected yet");
}

void loop() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.startsWith("ID:")) lockerId = line.substring(3);
  else if (line.startsWith("WEIGHT:")) weight = line.substring(7).toFloat();
  else if (line == "CAPTURE") captureAndUpload();
  // أي سطر تاني (طباعة الأردوينو للتجربة) بيتجاهل
}
```

## ٥. الطلب اللي الكاميرا بتبعته للسيرفر

`POST {SERVER_URL}/camera/upload` وجسم الطلب هو الصورة نفسها (JPEG).

| Header | مثال | مطلوب؟ |
|---|---|---|
| `Content-Type` | `image/jpeg` | أيوه |
| `X-Device-Key` | نفس `DEVICE_API_KEY` | أيوه |
| `X-Box-Id` | `box-001` | أيوه |
| `X-Locker-User-Id` | `583` (الـ ID اللي اتكتب على الكيباد) | أيوه |
| `X-Weight` | `350.25` (جرام) | مستحسن، بيتراجع على وزن المنتج |
| `X-Firmware-Version` | `1.0.0` | اختياري |

| الرد | المعنى |
|---|---|
| `200` | الصورة اتحفظت والمرتجع اتعلّم completed. الرد فيه `returnId` و`imageUrl` |
| `400` | ناقص `X-Locker-User-Id` أو الصورة فاضية |
| `401` / `403` | `X-Device-Key` ناقص أو غلط |
| `404` | مفيش مرتجع مفتوح بالـ ID ده (أو انتهت صلاحيته) |
| `409` | المرتجع مقفول أو اتفتح في صندوق تاني |
| `413` | الصورة أكبر من 5MB |
| `429` | أكتر من 5 صور في الدقيقة من نفس الصندوق |

لو صورة تانية اتبعتت لنفس المرتجع من نفس الصندوق خلال 15 دقيقة، بتتقبل (مفيدة لو حصل خطأ وحاولت تاني).

## ٦. التجربة

**الشبكة:** الكمبيوتر اللي عليه الباك إند والـ ESP32 لازم يكونوا على نفس الواي فاي. `SERVER_URL` هو IP الكمبيوتر (من `ipconfig` في الويندوز) مع `:3001`. لو الويندوز سأل عن الـ Firewall لـ Node.js، اسمح بـ Private networks.

**جرّب الكاميرا من غير الأردوينو:** وصّل الـ ESP32-CAM بالـ FTDI، وافتح Serial Monitor على `9600` مع `Newline`، واكتب السطور دي بالترتيب كأنك الأردوينو (بعد ما تعمل مرتجع من الأبلكيشن وتاخد الـ ID بتاعه):

```
ID:583
WEIGHT:350
CAPTURE
```

لازم يطبع `Upload attempt 1 -> 200 ...`.

**جرّب السيرفر من غير هاردوير خالص** (من الكمبيوتر، بأي صورة JPG):

```bash
curl -X POST http://localhost:3001/camera/upload -H "Content-Type: image/jpeg" -H "X-Device-Key: <DEVICE_API_KEY>" -H "X-Box-Id: box-001" -H "X-Locker-User-Id: 583" -H "X-Weight: 350" --data-binary @photo.jpg
```

**النتيجة بتظهر فين:** في لوحة الأدمن، صفحة **Camera Sessions** (الصورة والوزن ونتيجة المراجعة)، وصفحة **Returns** (المرتجع بقى completed).

**الاختبار الأوتوماتيكي للسيرفر:** `node tests/smartbox.flow.mjs http://localhost:3001 path/to/photo.jpg`

## ٧. حاجات لازم تبقى عارفها

- الصندوق بيتأكد من الكود لوحده، فمش عارف إن المرتجع انتهت صلاحيته (بعد 48 ساعة). الباب هيفتح، لكن السيرفر هيرفض الصورة (`404`) والمرتجع مش هيتقفل.
- مصر بتطبق التوقيت الصيفي والـ RTC لأ؛ في الصيف ممكن الكود يختلف في الساعة اللي بعد ١٢ بالليل بس.
- المعادلة بسيطة وأي حد يعرفها يقدر يحسب الكود؛ كفاية لمشروع التخرج. لو عايزين أمان أعلى، الصندوق ممكن يسأل السيرفر بدل ما يحسب بنفسه:
  `POST /returns/validate-code` بنفس `X-Device-Key` و`X-Box-Id`، والجسم `{"lockerUserId":"583","unlockCode":"7861"}`،
  والرد `{"action":"open","returnId":"..."}` أو `deny` / `expired` / `used`. ده محتاج الأردوينو يكلم الـ ESP32 في الاتجاهين.
