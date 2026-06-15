#include "app.h"

#include <BLE2902.h>
#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEUtils.h>
#include <WiFi.h>

#include "config.h" // Use config.h for all configurations
#include "esp_camera.h"
#include "esp_sleep.h"
#include "mic.h"
#include "opus_encoder.h"
#include "ota.h"
#include "streamer.h"

// Battery state
float batteryVoltage = 0.0f;
int batteryPercentage = 0;
unsigned long lastBatteryCheck = 0;

// Device power state
bool deviceActive = true;
device_state_t deviceState = DEVICE_BOOTING;

// Button and LED state
volatile bool buttonPressed = false;
unsigned long buttonPressTime = 0;
led_status_t ledMode = LED_BOOT_SEQUENCE;

// Gentle power optimization
unsigned long lastActivity = 0;
bool powerSaveMode = false;

// Light sleep optimization - saves ~15mA = adds 3-4 hours battery life
bool lightSleepEnabled = true;

// ---------------------------------------------------------------------------------
// BLE - Using config.h definitions
// ---------------------------------------------------------------------------------

// Main Friend Service - using config.h UUIDs
static BLEUUID serviceUUID(OMI_SERVICE_UUID);
static BLEUUID photoDataUUID(PHOTO_DATA_UUID);
static BLEUUID photoControlUUID(PHOTO_CONTROL_UUID);
static BLEUUID audioDataUUID(AUDIO_DATA_UUID);
static BLEUUID audioCodecUUID(AUDIO_CODEC_UUID);

// OTA Service UUIDs
static BLEUUID otaServiceUUID(OTA_SERVICE_UUID);
static BLEUUID otaControlUUID(OTA_CONTROL_UUID);
static BLEUUID otaDataUUID(OTA_DATA_UUID);

// Camera Control UUID
static BLEUUID cameraControlUUID(CAMERA_CONTROL_UUID);
static BLEUUID streamStatusUUID(STREAM_STATUS_UUID);

// Characteristics
BLECharacteristic *photoDataCharacteristic;
BLECharacteristic *photoControlCharacteristic;
BLECharacteristic *batteryLevelCharacteristic;
BLECharacteristic *audioDataCharacteristic;
BLECharacteristic *audioCodecCharacteristic;
BLECharacteristic *otaControlCharacteristic;
BLECharacteristic *otaDataCharacteristic;
BLECharacteristic *cameraControlCharacteristic;
BLECharacteristic *streamStatusCharacteristic;

// Audio state
bool audioEnabled = true;
volatile bool audioSubscribed = false;
uint16_t audioPacketIndex = 0;

// State
bool connected = false;
bool isCapturingPhotos = false;
int captureInterval = 0; // Interval in ms
unsigned long lastCaptureTime = 0;
bool singleShotPending = false;     // High-priority single shot
unsigned long captureRequestMs = 0; // Timestamp when capture was requested (for latency measurement)
bool liveStreamActive = false;
unsigned long liveStreamInterval = 1500;
int savedQuality = 12; // Restore quality after hi-res capture

// Audio ring buffer for encoded packets
#define AUDIO_TX_BUFFER_SIZE (AUDIO_TX_RING_BUFFER_SIZE * (OPUS_OUTPUT_MAX_BYTES + 2))
static uint8_t audio_tx_buffer[AUDIO_TX_BUFFER_SIZE];
static volatile size_t audio_tx_write_pos = 0;
static volatile size_t audio_tx_read_pos = 0;
static uint8_t audio_packet_buffer[OPUS_OUTPUT_MAX_BYTES + AUDIO_PACKET_HEADER_SIZE];

size_t sent_photo_bytes = 0;
size_t sent_photo_frames = 0;
bool photoDataUploading = false;

// -------------------------------------------------------------------------
// Camera Frame
// -------------------------------------------------------------------------
camera_fb_t *fb = nullptr;
image_orientation_t current_photo_orientation = ORIENTATION_0_DEGREES;

// Forward declarations
void handlePhotoControl(const uint8_t *data, size_t len);
void notifyPhotoControlStatus(uint8_t mode, uint16_t intervalSeconds);
void handleCameraControl(uint8_t *data, size_t len);
void readBatteryLevel();
void updateBatteryService();
void IRAM_ATTR buttonISR();
void handleButton();
void updateLED();
void blinkLED(int count, int delayMs);
void enterPowerSave();
void exitPowerSave();
void shutdownDevice();
void enableLightSleep();

// Audio forward declarations
void onMicData(int16_t *data, size_t samples);
void onOpusEncoded(uint8_t *data, size_t len);
void processAudioTx();
void broadcastAudioPacket(uint8_t *data, size_t len);

void notifyStreamStatus();

// -------------------------------------------------------------------------
// Button ISR
// -------------------------------------------------------------------------
void IRAM_ATTR buttonISR()
{
    buttonPressed = true;
}

// -------------------------------------------------------------------------
// LED Functions
// -------------------------------------------------------------------------
void updateLED()
{
    unsigned long now = millis();
    static unsigned long bootStartTime = 0;
    static unsigned long powerOffStartTime = 0;

    switch (ledMode) {
    case LED_BOOT_SEQUENCE:
        if (bootStartTime == 0)
            bootStartTime = now;

        // 5 quick blinks over 1.5 seconds total (inverted logic: HIGH=OFF, LOW=ON)
        if (now - bootStartTime < 1500) {
            int blinkPhase = ((now - bootStartTime) / 150) % 2;
            digitalWrite(STATUS_LED_PIN, !blinkPhase);
        } else {
            digitalWrite(STATUS_LED_PIN, HIGH); // OFF
            ledMode = LED_NORMAL_OPERATION;
            bootStartTime = 0;
        }
        break;

    case LED_POWER_OFF_SEQUENCE:
        if (powerOffStartTime == 0)
            powerOffStartTime = now;

        // 2 quick blinks over 800ms total (inverted logic: HIGH=OFF, LOW=ON)
        if (now - powerOffStartTime < 800) {
            int blinkPhase = ((now - powerOffStartTime) / 200) % 2;
            digitalWrite(STATUS_LED_PIN, !blinkPhase);
        } else {
            digitalWrite(STATUS_LED_PIN, HIGH); // OFF
            delay(100);
            shutdownDevice();
        }
        break;

    case LED_NORMAL_OPERATION:
    default:
        if (streamer_is_running()) {
            // Streaming - rapid blink (200ms on/off)
            int blinkPhase = (now / 200) % 2;
            digitalWrite(STATUS_LED_PIN, blinkPhase ? HIGH : LOW);
        } else if (connected) {
            // Connected - LED solid ON
            digitalWrite(STATUS_LED_PIN, LOW);
        } else {
            // Disconnected - LED slow blink (1 sec on, 1 sec off)
            int blinkPhase = (now / 1000) % 2;
            digitalWrite(STATUS_LED_PIN, blinkPhase ? HIGH : LOW);
        }
        break;
    }
}

void blinkLED(int count, int delayMs)
{
    for (int i = 0; i < count; i++) {
        digitalWrite(STATUS_LED_PIN, HIGH);
        delay(delayMs);
        digitalWrite(STATUS_LED_PIN, LOW);
        delay(delayMs);
    }
}

// -------------------------------------------------------------------------
// Button Handling
// -------------------------------------------------------------------------
void handleButton()
{
    unsigned long now = millis();
    static unsigned long lastDebounceTime = 0;
    static bool buttonDown = false;
    static bool longPressTriggered = false;

    bool currentButtonState = !digitalRead(POWER_BUTTON_PIN); // Active low (pressed = true)

    if (currentButtonState && !buttonDown) {
        // Button just pressed - debounce
        if (now - lastDebounceTime < 50) {
            return;
        }
        buttonPressTime = now;
        buttonDown = true;
        longPressTriggered = false;
        lastDebounceTime = now;

    } else if (currentButtonState && buttonDown && !longPressTriggered) {
        // Button still held - check for long press
        unsigned long pressDuration = now - buttonPressTime;
        if (pressDuration >= 2000) {
            // Long press threshold reached - trigger power off immediately
            longPressTriggered = true;
            ledMode = LED_POWER_OFF_SEQUENCE;
        }

    } else if (!currentButtonState && buttonDown) {
        // Button just released - debounce
        if (now - lastDebounceTime < 50) {
            return;
        }
        buttonDown = false;
        unsigned long pressDuration = now - buttonPressTime;
        lastDebounceTime = now;

        // Only handle short press if long press wasn't already triggered
        if (!longPressTriggered && pressDuration >= 50) {
            // Short press - register activity
            lastActivity = now;
            if (powerSaveMode) {
                exitPowerSave();
            }
        }
        longPressTriggered = false;
    }

    buttonPressed = false;
}

// -------------------------------------------------------------------------
// Power Management
// -------------------------------------------------------------------------
void enterPowerSave()
{
    if (!powerSaveMode) {
        setCpuFrequencyMhz(MIN_CPU_FREQ_MHZ); // 40MHz for idle
        powerSaveMode = true;
    }
}

void exitPowerSave()
{
    if (powerSaveMode) {
        setCpuFrequencyMhz(NORMAL_CPU_FREQ_MHZ); // Back to 80MHz
        powerSaveMode = false;
    }
}

void enableLightSleep()
{
    if (!lightSleepEnabled || !connected || photoDataUploading || streamer_is_running()) {
        return; // Don't sleep if disabled, not connected, uploading, or streaming
    }

    unsigned long now = millis();

    // Don't sleep if there was recent activity (within 5 seconds)
    if (now - lastActivity < 5000) {
        return;
    }

    unsigned long timeUntilNextPhoto = 0;

    if (isCapturingPhotos && captureInterval > 0) {
        unsigned long timeSinceLastPhoto = now - lastCaptureTime;
        if (timeSinceLastPhoto < captureInterval) {
            timeUntilNextPhoto = captureInterval - timeSinceLastPhoto;
        }
    }

    // Only sleep if we have at least 10 seconds until next photo
    if (timeUntilNextPhoto > 10000) {
        // Configure light sleep to wake on BLE events and timer
        unsigned long sleepTime = timeUntilNextPhoto - 5000;
        if (sleepTime > 15000)
            sleepTime = 15000;                           // Max 15 seconds
        esp_sleep_enable_timer_wakeup(sleepTime * 1000); // Wake 5s before photo or max 15s
        esp_light_sleep_start();
        lastActivity = millis(); // Update activity time after wake
    }
}

void shutdownDevice()
{
    Serial.println("Shutting down device...");

    // Stop audio
    mic_stop();

    // Stop photo capture
    isCapturingPhotos = false;

    // Stop WiFi streaming
    streamer_stop();

    // Disconnect BLE gracefully
    if (connected) {
        Serial.println("Disconnecting BLE...");
    }

    // Turn off LED (inverted logic)
    digitalWrite(STATUS_LED_PIN, HIGH);

    // Enter deep sleep
    esp_sleep_enable_ext0_wakeup(GPIO_NUM_1, 0); // Wake on button press
    Serial.println("Entering deep sleep...");
    delay(100);
    esp_deep_sleep_start();
}

// -------------------------------------------------------------------------
// Audio Functions
// -------------------------------------------------------------------------
void onMicData(int16_t *data, size_t samples)
{
    // Feed PCM data to Opus encoder
    opus_receive_pcm(data, samples);
}

void onOpusEncoded(uint8_t *data, size_t len)
{
    // Store encoded data in TX ring buffer
    if (len > OPUS_OUTPUT_MAX_BYTES) {
        return;
    }

    // Write length (2 bytes) + data
    size_t packet_size = len + 2;
    size_t next_write = (audio_tx_write_pos + packet_size) % AUDIO_TX_BUFFER_SIZE;

    // Check for buffer overflow
    if ((audio_tx_write_pos < audio_tx_read_pos && next_write >= audio_tx_read_pos) ||
        (audio_tx_write_pos >= audio_tx_read_pos && next_write < audio_tx_write_pos &&
         next_write >= audio_tx_read_pos)) {
        // Buffer full, skip this packet
        return;
    }

    // Write length
    audio_tx_buffer[audio_tx_write_pos] = len & 0xFF;
    audio_tx_buffer[(audio_tx_write_pos + 1) % AUDIO_TX_BUFFER_SIZE] = (len >> 8) & 0xFF;

    // Write data
    for (size_t i = 0; i < len; i++) {
        audio_tx_buffer[(audio_tx_write_pos + 2 + i) % AUDIO_TX_BUFFER_SIZE] = data[i];
    }

    audio_tx_write_pos = next_write;
}

void broadcastAudioPacket(uint8_t *data, size_t len)
{
    if (!connected || !audioSubscribed || audioDataCharacteristic == nullptr) {
        return;
    }

    // Build packet: 2 bytes index + 1 byte sub-index + data
    audio_packet_buffer[0] = audioPacketIndex & 0xFF;
    audio_packet_buffer[1] = (audioPacketIndex >> 8) & 0xFF;
    audio_packet_buffer[2] = 0; // Sub-index (for fragmentation if needed)

    memcpy(audio_packet_buffer + AUDIO_PACKET_HEADER_SIZE, data, len);

    audioDataCharacteristic->setValue(audio_packet_buffer, len + AUDIO_PACKET_HEADER_SIZE);
    audioDataCharacteristic->notify();

    audioPacketIndex++;
}

void processAudioTx()
{
    if (!connected || !audioSubscribed) {
        return;
    }

    if (audioDataCharacteristic == nullptr) {
        return;
    }

    // Check if we have data in the ring buffer
    while (audio_tx_read_pos != audio_tx_write_pos) {
        // Read length
        uint16_t len =
            audio_tx_buffer[audio_tx_read_pos] | (audio_tx_buffer[(audio_tx_read_pos + 1) % AUDIO_TX_BUFFER_SIZE] << 8);

        if (len == 0 || len > OPUS_OUTPUT_MAX_BYTES) {
            // Invalid packet, skip
            audio_tx_read_pos = (audio_tx_read_pos + 2) % AUDIO_TX_BUFFER_SIZE;
            continue;
        }

        // Read data
        static uint8_t temp_data[OPUS_OUTPUT_MAX_BYTES];
        for (size_t i = 0; i < len; i++) {
            temp_data[i] = audio_tx_buffer[(audio_tx_read_pos + 2 + i) % AUDIO_TX_BUFFER_SIZE];
        }

        // Update read position
        audio_tx_read_pos = (audio_tx_read_pos + 2 + len) % AUDIO_TX_BUFFER_SIZE;

        // Send packet
        broadcastAudioPacket(temp_data, len);

        // Small delay to prevent BLE congestion
        delay(1);
    }
}

// -------------------------------------------------------------------------
// BLE Callbacks
// -------------------------------------------------------------------------
class ServerHandler : public BLEServerCallbacks
{
    void onConnect(BLEServer *server) override
    {
        connected = true;
        audioSubscribed = false;
        lastActivity = millis(); // Register activity - prevents sleep
        Serial.println(">>> BLE Client connected.");
        updateBatteryService();
    }
    void onConnect(BLEServer *server, esp_ble_gatts_cb_param_t *param) override
    {
        connected = true;
        audioSubscribed = false;
        lastActivity = millis();
        Serial.println(">>> BLE Client connected.");
        updateBatteryService();

        if (param) {
            // Request faster connection interval for responsive photo transfer
            // Units: 1.25ms per count. Min 12 = 15ms, Max 16 = 20ms.
            server->updateConnParams(param->connect.remote_bda,
                                     BLE_CONN_MIN_INTERVAL,
                                     BLE_CONN_MAX_INTERVAL,
                                     BLE_CONN_LATENCY,
                                     BLE_CONN_TIMEOUT);
            Serial.println("BLE connection params updated (15-30ms interval, 4s supervision).");
        }
    }
    void onDisconnect(BLEServer *server) override
    {
        connected = false;
        audioSubscribed = false;
        Serial.println("<<< BLE Client disconnected. Restarting advertising.");
        BLEDevice::startAdvertising();
    }
};

// Callback for Audio Data CCCD (Client Characteristic Configuration Descriptor)
class AudioCCCDCallback : public BLEDescriptorCallbacks
{
    void onWrite(BLEDescriptor *pDescriptor)
    {
        uint8_t *value = pDescriptor->getValue();
        if (value && pDescriptor->getLength() >= 2) {
            // Check notification bit (bit 0)
            if (value[0] & 0x01) {
                audioSubscribed = true;
                Serial.println("Audio notifications enabled");
            } else {
                audioSubscribed = false;
                Serial.println("Audio notifications disabled");
            }
        }
    }
};

class AudioDataCallback : public BLECharacteristicCallbacks
{
    void onStatus(BLECharacteristic *pCharacteristic, Status s, uint32_t code)
    {
        if (s == Status::SUCCESS_NOTIFY || s == Status::SUCCESS_INDICATE) {
            // Notification sent successfully
        }
    }

    void onRead(BLECharacteristic *pCharacteristic)
    {
        // Client read the characteristic
    }
};

class PhotoControlCallback : public BLECharacteristicCallbacks
{
    void onWrite(BLECharacteristic *characteristic) override
    {
        size_t len = characteristic->getLength();
        if (len > 0) {
            const uint8_t *data = characteristic->getData();
            Serial.printf("PhotoControl received: command=0x%02x len=%u\n", data[0], (unsigned int) len);
            lastActivity = millis(); // Register activity - prevents sleep
            handlePhotoControl(data, len);
        }
    }
};

class OTAControlCallback : public BLECharacteristicCallbacks
{
    void onWrite(BLECharacteristic *pChar) override
    {
        std::string value = pChar->getValue();
        if (value.length() > 0) {
            ota_handle_command((uint8_t *) value.data(), value.length());
        }
    }

    void onRead(BLECharacteristic *pChar) override
    {
        uint8_t status[2] = {ota_get_status(), 0};
        pChar->setValue(status, 2);
    }
};

class CameraControlCallback : public BLECharacteristicCallbacks
{
    void onWrite(BLECharacteristic *pChar) override
    {
        size_t len = pChar->getLength();
        uint8_t *data = pChar->getData();
        if (len > 0) {
            lastActivity = millis();
            handleCameraControl(data, len);
        }
    }
};

// -------------------------------------------------------------------------
// Battery Functions
// -------------------------------------------------------------------------
void readBatteryLevel()
{
    // Take multiple ADC readings for stability
    int adcSum = 0;
    for (int i = 0; i < 10; i++) {
        int value = analogRead(BATTERY_ADC_PIN);
        adcSum += value;
        delay(10);
    }
    int adcValue = adcSum / 10;

    // ESP32-S3 ADC: 12-bit (0-4095), reference voltage ~3.3V
    float adcVoltage = (adcValue / 4095.0f) * 3.3f;

    // Apply voltage divider ratio to get actual battery voltage
    batteryVoltage = adcVoltage * VOLTAGE_DIVIDER_RATIO;

    // Clamp voltage to reasonable range
    if (batteryVoltage > 5.0f)
        batteryVoltage = 5.0f;
    if (batteryVoltage < 2.5f)
        batteryVoltage = 2.5f;

    // Load-compensated battery calculation (accounts for voltage sag under load)
    float loadCompensatedMax = BATTERY_MAX_VOLTAGE;
    float loadCompensatedMin = BATTERY_MIN_VOLTAGE;

    // More accurate percentage calculation for load conditions
    if (batteryVoltage >= loadCompensatedMax) {
        batteryPercentage = 100;
    } else if (batteryVoltage <= loadCompensatedMin) {
        batteryPercentage = 0;
    } else {
        float range = loadCompensatedMax - loadCompensatedMin;
        batteryPercentage = (int) (((batteryVoltage - loadCompensatedMin) / range) * 100.0f);
    }

    // Smooth percentage changes to avoid jumpy readings
    static int lastBatteryPercentage = batteryPercentage;
    if (abs(batteryPercentage - lastBatteryPercentage) > 5) {
        batteryPercentage = lastBatteryPercentage + (batteryPercentage > lastBatteryPercentage ? 2 : -2);
    }
    lastBatteryPercentage = batteryPercentage;

    // Clamp percentage
    if (batteryPercentage > 100)
        batteryPercentage = 100;
    if (batteryPercentage < 0)
        batteryPercentage = 0;

    // Battery status with load info
    Serial.print("Battery: ");
    Serial.print(batteryVoltage);
    Serial.print("V (");
    Serial.print(batteryPercentage);
    Serial.print("%) [Load-compensated: ");
    Serial.print(loadCompensatedMin);
    Serial.print("V-");
    Serial.print(loadCompensatedMax);
    Serial.println("V]");
}

void updateBatteryService()
{
    if (batteryLevelCharacteristic) {
        uint8_t batteryLevel = (uint8_t) batteryPercentage;
        batteryLevelCharacteristic->setValue(&batteryLevel, 1);

        if (connected) {
            batteryLevelCharacteristic->notify();
        }
    }
}

// -------------------------------------------------------------------------
// WiFi Scan Task
// -------------------------------------------------------------------------
static void wifi_scan_task(void *param)
{
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    int n = WiFi.scanNetworks();
    Serial.printf("[scan] found %d networks\n", n);

    for (int i = 0; i < n && i < 40; i++) {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0)
            continue;
        int rssi = WiFi.RSSI(i);

        uint8_t buf[2 + 1 + 32 + 1];
        buf[0] = STREAM_SCAN_RESULT;
        uint8_t ssidLen = min((int) ssid.length(), 32);
        buf[1] = ssidLen;
        memcpy(&buf[2], ssid.c_str(), ssidLen);
        buf[2 + ssidLen] = (uint8_t) (rssi & 0xFF);

        if (streamStatusCharacteristic && connected) {
            streamStatusCharacteristic->setValue(buf, 3 + ssidLen);
            streamStatusCharacteristic->notify();
        }
        delay(30);
    }

    // Scan done
    uint8_t done[2] = {STREAM_SCAN_DONE, (uint8_t) n};
    if (streamStatusCharacteristic && connected) {
        streamStatusCharacteristic->setValue(done, 2);
        streamStatusCharacteristic->notify();
    }

    WiFi.scanDelete();
    Serial.println("[scan] done");
    vTaskDelete(NULL);
}

// -------------------------------------------------------------------------
// configure_ble()
// -------------------------------------------------------------------------
void configure_ble()
{
    Serial.println("Initializing BLE...");
    BLEDevice::init(BLE_DEVICE_NAME);
    BLEDevice::setMTU(BLE_MTU_SIZE);
    Serial.printf("[BLE] device=%s service=%s mtu=%d\n", BLE_DEVICE_NAME, OMI_SERVICE_UUID, BLE_MTU_SIZE);
    BLEServer *server = BLEDevice::createServer();
    server->setCallbacks(new ServerHandler());

    // Main service
    BLEService *service = server->createService(serviceUUID, OMI_SERVICE_HANDLE_COUNT);

    // Audio Data characteristic (for streaming audio to app)
    Serial.println("[BLE] creating AUDIO_DATA (19b10001)");
    audioDataCharacteristic = service->createCharacteristic(
        audioDataUUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    if (!audioDataCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    BLE2902 *audioCcc = new BLE2902();
    audioCcc->setNotifications(true);
    audioCcc->setCallbacks(new AudioCCCDCallback());
    audioDataCharacteristic->addDescriptor(audioCcc);
    audioDataCharacteristic->setCallbacks(new AudioDataCallback());

    // Audio Codec characteristic (tells app which codec we're using)
    Serial.println("[BLE] creating AUDIO_CODEC (19b10002)");
    audioCodecCharacteristic = service->createCharacteristic(audioCodecUUID, BLECharacteristic::PROPERTY_READ);
    if (!audioCodecCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    uint8_t codecId = opus_get_codec_id();
    audioCodecCharacteristic->setValue(&codecId, 1);

    // Photo Data characteristic
    Serial.println("[BLE] creating PHOTO_DATA (19b10005)");
    photoDataCharacteristic = service->createCharacteristic(
        photoDataUUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    if (!photoDataCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    BLE2902 *ccc = new BLE2902();
    ccc->setNotifications(true);
    photoDataCharacteristic->addDescriptor(ccc);

    // Photo Control characteristic
    Serial.println("[BLE] creating PHOTO_CONTROL (19b10006)");
    photoControlCharacteristic = service->createCharacteristic(
        photoControlUUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);
    if (!photoControlCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    photoControlCharacteristic->setCallbacks(new PhotoControlCallback());
    BLE2902 *photoControlCcc = new BLE2902();
    photoControlCcc->setNotifications(true);
    photoControlCharacteristic->addDescriptor(photoControlCcc);
    uint8_t photoControlStatus[] = {PHOTO_STATUS_STOPPED, 0, 0};
    photoControlCharacteristic->setValue(photoControlStatus, sizeof(photoControlStatus));

    // Camera Control characteristic (for live camera tuning from debug UI)
    Serial.println("[BLE] creating CAMERA_CONTROL (19b10007)");
    cameraControlCharacteristic = service->createCharacteristic(cameraControlUUID, BLECharacteristic::PROPERTY_WRITE);
    if (!cameraControlCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    cameraControlCharacteristic->setCallbacks(new CameraControlCallback());

    // Stream Status characteristic (for WiFi streaming status)
    Serial.println("[BLE] creating STREAM_STATUS (19b10008)");
    streamStatusCharacteristic = service->createCharacteristic(
        streamStatusUUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    if (!streamStatusCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    BLE2902 *streamCcc = new BLE2902();
    streamCcc->setNotifications(true);
    streamStatusCharacteristic->addDescriptor(streamCcc);
    uint8_t streamStatus[] = {STREAM_STATUS_IDLE};
    streamStatusCharacteristic->setValue(streamStatus, sizeof(streamStatus));

    // Battery Service
    Serial.println("[BLE] creating battery service (0x180F)");
    BLEService *batteryService = server->createService(BATTERY_SERVICE_UUID);
    Serial.println("[BLE] creating battery level (0x2A19)");
    batteryLevelCharacteristic = batteryService->createCharacteristic(
        BATTERY_LEVEL_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    if (!batteryLevelCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    BLE2902 *batteryCcc = new BLE2902();
    batteryCcc->setNotifications(true);
    batteryLevelCharacteristic->addDescriptor(batteryCcc);

    // Set initial battery level
    readBatteryLevel();
    uint8_t initialBatteryLevel = (uint8_t) batteryPercentage;
    batteryLevelCharacteristic->setValue(&initialBatteryLevel, 1);

    // OTA Service
    Serial.println("[BLE] creating OTA service (19b10010)");
    BLEService *otaService = server->createService(otaServiceUUID);

    // OTA Control characteristic (for receiving commands and reading status)
    Serial.println("[BLE] creating OTA_CONTROL (19b10011)");
    otaControlCharacteristic = otaService->createCharacteristic(
        otaControlUUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
    if (!otaControlCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    otaControlCharacteristic->setCallbacks(new OTAControlCallback());

    // OTA Data characteristic (for progress notifications)
    Serial.println("[BLE] creating OTA_DATA (19b10012)");
    otaDataCharacteristic = otaService->createCharacteristic(
        otaDataUUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    if (!otaDataCharacteristic) {
        Serial.println("[BLE] FAILED - nullptr!");
    }
    BLE2902 *otaCcc = new BLE2902();
    otaCcc->setNotifications(true);
    otaDataCharacteristic->addDescriptor(otaCcc);

    // Set OTA characteristics for the OTA module
    ota_set_characteristics(otaControlCharacteristic, otaDataCharacteristic);

    // Start services
    service->start();
    Serial.printf("[BLE] handles audio=%04x codec=%04x photo=%04x control=%04x camera=%04x stream=%04x\n",
                  audioDataCharacteristic->getHandle(),
                  audioCodecCharacteristic->getHandle(),
                  photoDataCharacteristic->getHandle(),
                  photoControlCharacteristic->getHandle(),
                  cameraControlCharacteristic->getHandle(),
                  streamStatusCharacteristic->getHandle());
    batteryService->start();
    otaService->start();

    // Start advertising
    BLEAdvertising *advertising = BLEDevice::getAdvertising();
    BLEAdvertisementData advertisementData;
    advertisementData.setFlags(ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT);
    advertisementData.setName(BLE_DEVICE_NAME);
    advertising->setAdvertisementData(advertisementData);

    BLEAdvertisementData scanResponseData;
    scanResponseData.setCompleteServices(serviceUUID);
    advertising->setScanResponseData(scanResponseData);
    advertising->setScanResponse(true);
    advertising->setMinPreferred(BLE_ADV_MIN_INTERVAL);
    advertising->setMaxPreferred(BLE_ADV_MAX_INTERVAL);
    BLEDevice::startAdvertising();

    Serial.println("BLE initialized and advertising started.");
}

// -------------------------------------------------------------------------
// Camera
// -------------------------------------------------------------------------
static uint16_t s_capture_seq = 0;
bool take_photo()
{
    // Release previous buffer
    if (fb) {
        Serial.println("Releasing previous camera buffer...");
        esp_camera_fb_return(fb);
        fb = nullptr;
    }

    // Flush camera FIFO: discard one stale frame, then capture a fresh one
    {
        camera_fb_t *stale = esp_camera_fb_get();
        if (stale) {
            esp_camera_fb_return(stale);
        }
    }

    Serial.println("Capturing photo...");
    fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("Failed to get camera frame buffer!");
        return false;
    }
    s_capture_seq++;
    Serial.print("[DIAG] capture #");
    Serial.print(s_capture_seq);
    Serial.print(" fb=0x");
    Serial.print((uint32_t) fb, HEX);
    Serial.print(" len=");
    Serial.print(fb->len);
    Serial.println(" bytes.");

    // Set fixed orientation for the captured photo
    current_photo_orientation = FIXED_IMAGE_ORIENTATION;
    Serial.println("Photo orientation set to 180 degrees (fixed).");

    lastActivity = millis(); // Register activity
    return true;
}

void notifyPhotoControlStatus(uint8_t mode, uint16_t intervalSeconds)
{
    if (photoControlCharacteristic == nullptr) {
        return;
    }
    uint8_t status[] = {
        mode,
        (uint8_t) (intervalSeconds & 0xFF),
        (uint8_t) ((intervalSeconds >> 8) & 0xFF),
    };
    photoControlCharacteristic->setValue(status, sizeof(status));
    if (connected) {
        photoControlCharacteristic->notify();
    }
}

void notifyStreamStatus()
{
    if (streamStatusCharacteristic == nullptr) {
        return;
    }
    int status = streamer_get_status();
    if (status == STREAM_STATUS_CONNECTED) {
        String ip = streamer_get_ip();
        uint8_t buf[18];
        buf[0] = (uint8_t) status;
        size_t ipLen = ip.length();
        if (ipLen > 16)
            ipLen = 16;
        memcpy(&buf[1], ip.c_str(), ipLen);
        buf[1 + ipLen] = 0;
        streamStatusCharacteristic->setValue(buf, 2 + ipLen);
    } else {
        uint8_t s = (uint8_t) status;
        streamStatusCharacteristic->setValue(&s, 1);
    }
    if (connected) {
        streamStatusCharacteristic->notify();
    }
}

void handlePhotoControl(const uint8_t *data, size_t len)
{
    if (len == 0) {
        return;
    }

    // Legacy protocol: 0xFF=single, 0x00=stop, 5..127=start interval capture.
    if (len == 1 && data[0] == 0xFF) {
        Serial.println("Received command: Single photo.");
        isCapturingPhotos = true;
        captureInterval = 0;
        notifyPhotoControlStatus(PHOTO_STATUS_SINGLE, 0);
        return;
    }
    if (len == 1 && data[0] == 0) {
        Serial.println("Received command: Stop photo capture.");
        isCapturingPhotos = false;
        captureInterval = 0;
        notifyPhotoControlStatus(PHOTO_STATUS_STOPPED, 0);
        return;
    }
    if (len == 1 && data[0] >= 1 && data[0] <= 127) {
        Serial.print("Received command: Start interval capture with parameter ");
        Serial.println(data[0]);
        captureInterval = data[0] * 1000;
        isCapturingPhotos = true;
        lastCaptureTime = millis() - captureInterval;
        notifyPhotoControlStatus(PHOTO_STATUS_INTERVAL, data[0]);
        return;
    }

    if (len < 3) {
        Serial.println("PhotoControl: invalid v2 command length");
        return;
    }

    uint8_t command = data[0];
    uint16_t intervalSeconds = data[1] | (data[2] << 8);
    if (command == PHOTO_CMD_SINGLE) {
        // Ignore if a photo is already being uploaded
        if (photoDataUploading)
            return;
        singleShotPending = true;
        notifyPhotoControlStatus(PHOTO_STATUS_SINGLE, 0);
    } else if (command == PHOTO_CMD_STOP) {
        isCapturingPhotos = false;
        captureInterval = 0;
        liveStreamActive = false;
        singleShotPending = false;
        notifyPhotoControlStatus(PHOTO_STATUS_STOPPED, 0);
    } else if (command == PHOTO_CMD_INTERVAL && intervalSeconds >= 1 && intervalSeconds <= 300) {
        liveStreamActive = false;
        captureInterval = intervalSeconds * 1000;
        isCapturingPhotos = true;
        lastCaptureTime = millis() - captureInterval;
        notifyPhotoControlStatus(PHOTO_STATUS_INTERVAL, intervalSeconds);
    } else if (command == PHOTO_CMD_LIVE_STREAM && len >= 6) {
        liveStreamActive = data[1] ? true : false;
        if (liveStreamActive) {
            isCapturingPhotos = false;
            // Save current quality for restoration
            savedQuality = 12;
            // Set live stream parameters
            framesize_t fs = (framesize_t) data[2];
            if (fs <= FRAMESIZE_UXGA) {
                sensor_t *s = esp_camera_sensor_get();
                if (s)
                    s->set_framesize(s, fs);
            }
            uint8_t q = data[3];
            if (q >= 10 && q <= 63) {
                sensor_t *s = esp_camera_sensor_get();
                if (s)
                    s->set_quality(s, q);
            }
            liveStreamInterval = data[4] | (data[5] << 8);
            if (liveStreamInterval < 500)
                liveStreamInterval = 500; // Min 500ms
            if (liveStreamInterval > 10000)
                liveStreamInterval = 10000; // Max 10s
            lastCaptureTime = millis() - liveStreamInterval;
            notifyPhotoControlStatus(PHOTO_STATUS_LIVE, 0);
            Serial.printf(
                "Live stream started: framesize=%d quality=%d interval=%ums\n", data[2], q, liveStreamInterval);
        } else {
            Serial.println("Live stream stopped");
            notifyPhotoControlStatus(PHOTO_STATUS_STOPPED, 0);
        }
    } else if (command == PHOTO_CMD_CAPTURE_HIRES) {
        // Capture one frame at quality=8 for maximum detail
        sensor_t *s = esp_camera_sensor_get();
        int restoreQuality = 12;
        if (s) {
            restoreQuality = s->status.quality;
            s->set_quality(s, 8);
        }
        singleShotPending = true;
        // Schedule restoring quality after capture
        savedQuality = restoreQuality;
        notifyPhotoControlStatus(PHOTO_STATUS_SINGLE, 0);
        Serial.println("Hi-res capture requested (quality=8)");
    } else if (command == STREAM_CMD_CONNECT_WIFI && len >= 4) {
        // Format: [0x06, ssid_len, ssid..., pass_len, pass...]
        uint8_t ssidLen = data[1];
        if (ssidLen > WIFI_MAX_SSID_LEN || ssidLen + 2 >= len) {
            Serial.println("Stream: invalid SSID length");
            return;
        }
        uint8_t passLen = data[2 + ssidLen];
        if (passLen > WIFI_MAX_PASS_LEN || 3 + ssidLen + passLen > len) {
            Serial.println("Stream: invalid password length");
            return;
        }
        char ssid[WIFI_MAX_SSID_LEN + 1];
        char pass[WIFI_MAX_PASS_LEN + 1];
        memcpy(ssid, &data[2], ssidLen);
        ssid[ssidLen] = 0;
        memcpy(pass, &data[3 + ssidLen], passLen);
        pass[passLen] = 0;

        Serial.printf("Stream: connecting to WiFi SSID=%s\n", ssid);
        streamer_start(ssid, pass);
        notifyStreamStatus();
    } else if (command == STREAM_CMD_DISCONNECT) {
        Serial.println("Stream: disconnect requested");
        streamer_stop();
        notifyStreamStatus();
    } else if (command == STREAM_CMD_SCAN) {
        Serial.println("Stream: WiFi scan requested");
        xTaskCreate(wifi_scan_task, "wifi_scan", 8192, NULL, 1, NULL);
    } else if (command == STREAM_CMD_SET_CONFIG && len >= 3) {
        int fs = data[1];
        int q = data[2];
        if (q < 10) q = 10;
        if (q > 63) q = 63;
        Serial.printf("Stream: set config framesize=%d quality=%d\n", fs, q);
        streamer_set_config(fs, q);
    } else {
        Serial.printf("PhotoControl: invalid command=0x%02x interval=%u\n", command, intervalSeconds);
    }
}

// -------------------------------------------------------------------------
// handleCameraControl()
// -------------------------------------------------------------------------
void handleCameraControl(uint8_t *data, size_t len)
{
    if (len < 2)
        return;

    sensor_t *s = esp_camera_sensor_get();
    if (!s) {
        Serial.println("Camera control: sensor not available");
        return;
    }

    uint8_t cmd = data[0];
    int32_t val;
    switch (cmd) {
    case CAM_CMD_SET_FRAMESIZE:
        val = data[1];
        if (val <= FRAMESIZE_UXGA) {
            s->set_framesize(s, (framesize_t) val);
            Serial.printf("Camera: framesize=%d\n", val);
        }
        break;
    case CAM_CMD_SET_QUALITY:
        val = data[1];
        if (val >= 10 && val <= 63) {
            s->set_quality(s, val);
            Serial.printf("Camera: quality=%d\n", val);
        }
        break;
    case CAM_CMD_SET_BRIGHTNESS:
        val = (int8_t) data[1];
        if (val >= -2 && val <= 2) {
            s->set_brightness(s, val);
            Serial.printf("Camera: brightness=%d\n", val);
        }
        break;
    case CAM_CMD_SET_CONTRAST:
        val = (int8_t) data[1];
        if (val >= -2 && val <= 2) {
            s->set_contrast(s, val);
            Serial.printf("Camera: contrast=%d\n", val);
        }
        break;
    case CAM_CMD_SET_SATURATION:
        val = (int8_t) data[1];
        if (val >= -2 && val <= 2) {
            s->set_saturation(s, val);
            Serial.printf("Camera: saturation=%d\n", val);
        }
        break;
    case CAM_CMD_SET_AE_LEVEL:
        val = (int8_t) data[1];
        if (val >= -2 && val <= 2) {
            s->set_ae_level(s, val);
            Serial.printf("Camera: ae_level=%d\n", val);
        }
        break;
    case CAM_CMD_SET_AEC_VALUE:
        if (len < 3)
            return;
        val = data[1] | (data[2] << 8);
        if (val <= 1200) {
            s->set_aec_value(s, val);
            Serial.printf("Camera: aec_value=%d\n", val);
        }
        break;
    case CAM_CMD_SET_GAINCEILING:
        val = data[1];
        if (val <= 6) {
            s->set_gainceiling(s, (gainceiling_t) val);
            Serial.printf("Camera: gainceiling=%d\n", val);
        }
        break;
    case CAM_CMD_SET_WHITEBAL:
        s->set_whitebal(s, data[1]);
        Serial.printf("Camera: whitebal=%d\n", data[1]);
        break;
    case CAM_CMD_SET_AWB_GAIN:
        s->set_awb_gain(s, data[1]);
        Serial.printf("Camera: awb_gain=%d\n", data[1]);
        break;
    case CAM_CMD_SET_HMIRROR:
        s->set_hmirror(s, data[1]);
        Serial.printf("Camera: hmirror=%d\n", data[1]);
        break;
    case CAM_CMD_SET_VFLIP:
        s->set_vflip(s, data[1]);
        Serial.printf("Camera: vflip=%d\n", data[1]);
        break;
    case CAM_CMD_SET_AEC:
        s->set_exposure_ctrl(s, data[1]);
        Serial.printf("Camera: aec=%d\n", data[1]);
        break;
    case CAM_CMD_SET_AGC:
        s->set_gain_ctrl(s, data[1]);
        Serial.printf("Camera: agc=%d\n", data[1]);
        break;
    case CAM_CMD_SET_WB_MODE:
        if (data[1] <= 4) {
            s->set_wb_mode(s, data[1]);
            Serial.printf("Camera: wb_mode=%d\n", data[1]);
        }
        break;
    case CAM_CMD_SET_AGC_GAIN:
        if (data[1] <= 30) {
            s->set_agc_gain(s, data[1]);
            Serial.printf("Camera: agc_gain=%d\n", data[1]);
        }
        break;
    case CAM_CMD_SET_AEC2:
        s->set_aec2(s, data[1] ? 1 : 0);
        Serial.printf("Camera: aec2=%d\n", data[1]);
        break;
    case CAM_CMD_SET_EFFECT:
        if (data[1] <= 6) {
            s->set_special_effect(s, data[1]);
            Serial.printf("Camera: effect=%d\n", data[1]);
        }
        break;
    case CAM_CMD_SET_BPC:
        s->set_bpc(s, data[1] ? 1 : 0);
        Serial.printf("Camera: bpc=%d\n", data[1]);
        break;
    case CAM_CMD_SET_WPC:
        s->set_wpc(s, data[1] ? 1 : 0);
        Serial.printf("Camera: wpc=%d\n", data[1]);
        break;
    case CAM_CMD_SET_RAW_GMA:
        s->set_raw_gma(s, data[1] ? 1 : 0);
        Serial.printf("Camera: raw_gma=%d\n", data[1]);
        break;
    case CAM_CMD_SET_LENC:
        s->set_lenc(s, data[1] ? 1 : 0);
        Serial.printf("Camera: lenc=%d\n", data[1]);
        break;
    case CAM_CMD_SET_DCW:
        s->set_dcw(s, data[1] ? 1 : 0);
        Serial.printf("Camera: dcw=%d\n", data[1]);
        break;
    case CAM_CMD_SET_COLORBAR:
        s->set_colorbar(s, data[1] ? 1 : 0);
        Serial.printf("Camera: colorbar=%d\n", data[1]);
        break;
    default:
        Serial.printf("Camera: unknown cmd 0x%02x\n", cmd);
        break;
    }
}

// -------------------------------------------------------------------------
// configure_camera()
// -------------------------------------------------------------------------
void configure_camera()
{
    Serial.println("Initializing camera...");
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer = LEDC_TIMER_0;
    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;
    config.pin_sscb_sda = SIOD_GPIO_NUM;
    config.pin_sscb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = CAMERA_XCLK_FREQ;

    // Use config.h camera settings optimized for battery life
    config.frame_size = CAMERA_FRAME_SIZE;
    config.pixel_format = PIXFORMAT_JPEG;
    config.fb_count = 1;
    config.jpeg_quality = CAMERA_JPEG_QUALITY;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        Serial.printf("Camera init failed with error 0x%x\n", err);
    } else {
        Serial.println("Camera initialized successfully.");

        // Post-init sensor configuration for optimal image quality
        sensor_t *s = esp_camera_sensor_get();
        if (s) {
            s->set_framesize(s, CAMERA_FRAME_SIZE);
            s->set_quality(s, CAMERA_JPEG_QUALITY);
            s->set_brightness(s, 0);
            s->set_contrast(s, 0);
            s->set_saturation(s, 1);
            s->set_ae_level(s, 0);
            s->set_aec_value(s, 500);
            s->set_whitebal(s, 1);
            s->set_awb_gain(s, 1);
            s->set_gain_ctrl(s, 1);
            s->set_exposure_ctrl(s, 1);
            s->set_agc_gain(s, 0);
            s->set_gainceiling(s, GAINCEILING_4X);
            s->set_bpc(s, 0);
            s->set_wpc(s, 1);
            s->set_raw_gma(s, 1);
            s->set_lenc(s, 1);
            s->set_hmirror(s, 0);
            s->set_vflip(s, 0);
            s->set_dcw(s, 1);
            Serial.println("Sensor configuration applied.");
        } else {
            Serial.println("Warning: could not get sensor pointer.");
        }
    }
}

// -------------------------------------------------------------------------
// Setup & Loop
// -------------------------------------------------------------------------

// A small buffer for sending photo chunks over BLE
static uint8_t *s_compressed_frame_2 = nullptr;

void setup_app()
{
    Serial.begin(921600);
    Serial.println("Setup started...");

    // Initialize GPIO
    pinMode(POWER_BUTTON_PIN, INPUT_PULLUP);
    pinMode(STATUS_LED_PIN, OUTPUT);

    // LED uses inverted logic: HIGH = OFF, LOW = ON
    digitalWrite(STATUS_LED_PIN, HIGH);

    // Setup button interrupt
    attachInterrupt(digitalPinToInterrupt(POWER_BUTTON_PIN), buttonISR, CHANGE);

    // Start LED boot sequence
    ledMode = LED_BOOT_SEQUENCE;

    // Power optimization from config.h
    setCpuFrequencyMhz(NORMAL_CPU_FREQ_MHZ);
    lastActivity = millis();

    configure_ble();
    configure_camera();

    // Allocate buffer for photo chunks (chunk_size + 2/3 for frame index + orientation)
    s_compressed_frame_2 = (uint8_t *) ps_calloc(BLE_CHUNK_SIZE + 3, sizeof(uint8_t));
    if (!s_compressed_frame_2) {
        Serial.println("Failed to allocate chunk buffer!");
    } else {
        Serial.println("Chunk buffer allocated successfully.");
    }

    // Photo capture starts on [0x05] command from app (after BLE subscription)
    // isCapturingPhotos = true; // Delayed to avoid race with BLE notification subscription
    captureInterval = PHOTO_CAPTURE_INTERVAL_MS;
    lastCaptureTime = millis() - captureInterval;
    Serial.print("Capture interval set to ");
    Serial.print(PHOTO_CAPTURE_INTERVAL_MS / 1000);
    Serial.println(" seconds.");

    // Initial battery reading
    // Battery voltage divider
    analogReadResolution(12);                           // optional: set 12-bit resolution
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db); // set attenuation for full 3.3V range

    readBatteryLevel();
    deviceState = DEVICE_ACTIVE;

    // Initialize audio subsystem
    Serial.println("Initializing audio subsystem...");
    if (opus_encoder_init()) {
        opus_set_callback(onOpusEncoded);

        if (mic_start()) {
            mic_set_callback(onMicData);
            Serial.println("Audio subsystem initialized successfully.");
        } else {
            Serial.println("Failed to start microphone!");
        }
    } else {
        Serial.println("Failed to initialize Opus encoder!");
    }

    Serial.println("Setup complete.");
    Serial.println("Light sleep optimization enabled for extended battery life.");
}

void loop_app()
{
    static int lastStreamStatus = -1;
    int currentStreamStatus = streamer_get_status();
    if (currentStreamStatus != lastStreamStatus) {
        lastStreamStatus = currentStreamStatus;
        notifyStreamStatus();
    }

    unsigned long now = millis();

    // Handle button presses
    handleButton();

    // Update LED
    updateLED();

    // Process OTA updates
    ota_loop();

    // Process microphone data - always run to keep audio realtime
    if (audioEnabled && mic_is_running()) {
        mic_process();
        opus_process();
    }

    // Send audio packets over BLE - PRIORITY over photo
    if (connected && audioSubscribed) {
        processAudioTx();
    }

    // Check for power save mode (gentle optimization)
    if (!connected && !photoDataUploading && (now - lastActivity > IDLE_THRESHOLD_MS)) {
        enterPowerSave();
    } else if (connected || photoDataUploading) {
        if (powerSaveMode)
            exitPowerSave();
        lastActivity = now;
    }

    // Check battery level periodically
    if (now - lastBatteryCheck >= BATTERY_TASK_INTERVAL_MS) {
        readBatteryLevel();
        updateBatteryService();
        lastBatteryCheck = now;
    }

    // Force battery update on first connection
    static bool firstBatteryUpdate = true;
    if (connected && firstBatteryUpdate) {
        readBatteryLevel();
        updateBatteryService();
        firstBatteryUpdate = false;
    }

    // High-priority single shot (bypasses photoDataUploading gate)
    if (singleShotPending && connected && !photoDataUploading) {
        singleShotPending = false;
        unsigned long t0 = micros();
        Serial.println("Single shot triggered (high priority).");
        if (take_photo()) {
            unsigned long t1 = micros();
            Serial.print("Capture+encode latency: ");
            Serial.print(t1 - t0);
            Serial.println(" us");
            photoDataUploading = true;
            sent_photo_bytes = 0;
            sent_photo_frames = 0;
            lastCaptureTime = now;
        }
    }

    // Live stream mode: capture at fast interval
    if (liveStreamActive && connected && !photoDataUploading) {
        if (now - lastCaptureTime >= liveStreamInterval) {
            if (take_photo()) {
                photoDataUploading = true;
                sent_photo_bytes = 0;
                sent_photo_frames = 0;
                lastCaptureTime = now;
            }
        }
    }

    // Normal interval capture
    if (isCapturingPhotos && !photoDataUploading && connected && !liveStreamActive) {
        if ((captureInterval == 0) || (now - lastCaptureTime >= (unsigned long) captureInterval)) {
            if (captureInterval == 0) {
                // Single shot if interval=0
                isCapturingPhotos = false;
                notifyPhotoControlStatus(PHOTO_STATUS_STOPPED, 0);
            }
            Serial.println("Interval reached. Capturing photo...");
            if (take_photo()) {
                Serial.println("Photo capture successful. Starting upload...");
                photoDataUploading = true;
                sent_photo_bytes = 0;
                sent_photo_frames = 0;
                lastCaptureTime = now;
            }
        }
    }

    // Log BLE transfer start once per photo
    static unsigned long bleTransferStart = 0;

    // If uploading, send all remaining chunks immediately
    if (photoDataUploading && fb) {
        if (bleTransferStart == 0) {
            bleTransferStart = micros();
        }
        size_t remaining = fb->len - sent_photo_bytes;
        while (remaining > 0) {
            size_t bytes_to_copy;
            if (sent_photo_frames == 0) {
                s_compressed_frame_2[0] = 0;
                s_compressed_frame_2[1] = 0;
                s_compressed_frame_2[2] = (uint8_t) current_photo_orientation;
                bytes_to_copy = (remaining > BLE_CHUNK_SIZE - 1) ? BLE_CHUNK_SIZE - 1 : remaining;
                memcpy(&s_compressed_frame_2[3], &fb->buf[sent_photo_bytes], bytes_to_copy);
                photoDataCharacteristic->setValue(s_compressed_frame_2, bytes_to_copy + 3);
            } else {
                s_compressed_frame_2[0] = (uint8_t) (sent_photo_frames & 0xFF);
                s_compressed_frame_2[1] = (uint8_t) ((sent_photo_frames >> 8) & 0xFF);
                bytes_to_copy = (remaining > BLE_CHUNK_SIZE) ? BLE_CHUNK_SIZE : remaining;
                memcpy(&s_compressed_frame_2[2], &fb->buf[sent_photo_bytes], bytes_to_copy);
                photoDataCharacteristic->setValue(s_compressed_frame_2, bytes_to_copy + 2);
            }
            photoDataCharacteristic->notify();
            delay(5);

            sent_photo_bytes += bytes_to_copy;
            sent_photo_frames++;
            remaining = fb->len - sent_photo_bytes;

            lastActivity = now;
        }

        delay(5);

        // End of photo marker
        s_compressed_frame_2[0] = 0xFF;
        s_compressed_frame_2[1] = 0xFF;
        photoDataCharacteristic->setValue(s_compressed_frame_2, 2);
        photoDataCharacteristic->notify();
        unsigned long bleElapsed = micros() - bleTransferStart;
        bleTransferStart = 0;

        Serial.print("[DIAG] upload done: seq=");
        Serial.print(s_capture_seq);
        Serial.print(" chunks=");
        Serial.print(sent_photo_frames);
        Serial.print(" bytes=");
        Serial.println(sent_photo_bytes);
        photoDataUploading = false;
        esp_camera_fb_return(fb);
        fb = nullptr;
    }

    // Light sleep optimization - major power savings while maintaining BLE
    // Disable light sleep when audio is active
    if (!photoDataUploading && !audioSubscribed) {
        enableLightSleep();
    }

    // Adaptive delays for power saving (gentle optimization)
    if (photoDataUploading || audioSubscribed) {
        delay(5); // Fast during upload or audio streaming
    } else if (powerSaveMode) {
        delay(50); // Reduced delay with light sleep
    } else {
        delay(50); // Reduced delay with light sleep
    }
}
