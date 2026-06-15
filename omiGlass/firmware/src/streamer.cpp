#include "streamer.h"

#include <WebServer.h>
#include <WiFi.h>

#include "config.h"
#include "esp_camera.h"

extern void notifyStreamStatus();

static bool s_running = false;
static bool s_streaming = false;
static String s_ip = "";
static int s_status = STREAM_STATUS_IDLE;
static framesize_t s_framesize = STREAM_FRAMESIZE;
static int s_quality = STREAM_JPEG_QUALITY;
static WebServer *s_server = nullptr;
static TaskHandle_t s_stream_task = nullptr;
static TaskHandle_t s_connect_task = nullptr;
static char s_pending_ssid[WIFI_MAX_SSID_LEN + 1] = {};
static char s_pending_password[WIFI_MAX_PASS_LEN + 1] = {};

static void set_camera_for_streaming()
{
    sensor_t *s = esp_camera_sensor_get();
    if (!s)
        return;
    framesize_t old_fs = s->status.framesize;
    if (old_fs != s_framesize) {
        s->set_framesize(s, s_framesize);
    }
    int old_q = s->status.quality;
    if (old_q != s_quality) {
        s->set_quality(s, s_quality);
    }
}

static void restore_camera_settings()
{
    sensor_t *s = esp_camera_sensor_get();
    if (!s)
        return;
    s->set_framesize(s, CAMERA_FRAME_SIZE);
    s->set_quality(s, CAMERA_JPEG_QUALITY);
}

static void stream_task(void *param)
{
    s_server = new WebServer(STREAM_PORT);

    s_server->on("/stream", HTTP_GET, []() {
        WiFiClient client = s_server->client();
        if (!client)
            return;

        s_streaming = true;
        set_camera_for_streaming();

        client.println("HTTP/1.1 200 OK");
        client.print("Content-Type: multipart/x-mixed-replace; boundary=");
        client.println(STREAM_BOUNDARY);
        client.println("Cache-Control: no-cache");
        client.println("Pragma: no-cache");
        client.println("Connection: close");
        client.println();

        while (client.connected() && s_running) {
            camera_fb_t *fb = esp_camera_fb_get();
            if (!fb) {
                delay(10);
                continue;
            }

            client.print("--");
            client.println(STREAM_BOUNDARY);
            client.println("Content-Type: image/jpeg");
            client.print("Content-Length: ");
            client.println(fb->len);
            client.println();
            client.write(fb->buf, fb->len);
            client.println();

            esp_camera_fb_return(fb);
        }

        s_streaming = false;
    });

    s_server->on("/cam", HTTP_GET, []() {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) {
            s_server->send(500, "text/plain", "capture failed");
            return;
        }
        s_server->send_P(200, "image/jpeg", (const char *) fb->buf, fb->len);
        esp_camera_fb_return(fb);
    });

    s_server->begin();

    while (s_running) {
        s_server->handleClient();
        delay(5);
    }

    s_server->stop();
    delete s_server;
    s_server = nullptr;
    restore_camera_settings();
    vTaskDelete(NULL);
}

static void connect_task(void *param)
{
    if (s_running) {
        streamer_stop();
        delay(500);
    }

    WiFi.mode(WIFI_STA);
    WiFi.begin(s_pending_ssid, s_pending_password);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
            s_status = STREAM_STATUS_FAILED;
            s_connect_task = nullptr;
            Serial.println("[streamer] WiFi connect timeout");
            notifyStreamStatus();
            vTaskDelete(NULL);
        }
        delay(200);
        Serial.print(".");
    }
    Serial.println();

    s_ip = WiFi.localIP().toString();
    s_status = STREAM_STATUS_CONNECTED;
    s_running = true;
    Serial.printf("[streamer] WiFi connected, IP: %s\n", s_ip.c_str());

    notifyStreamStatus();
    xTaskCreatePinnedToCore(stream_task, "stream_task", 8192, NULL, 1, &s_stream_task, 1);
    s_connect_task = nullptr;
    vTaskDelete(NULL);
}

void streamer_start(const char *ssid, const char *password)
{
    if (s_connect_task) {
        Serial.println("[streamer] connection already in progress");
        return;
    }

    strlcpy(s_pending_ssid, ssid, sizeof(s_pending_ssid));
    strlcpy(s_pending_password, password, sizeof(s_pending_password));
    s_status = STREAM_STATUS_CONNECTING;
    s_ip = "";
    BaseType_t result = xTaskCreatePinnedToCore(connect_task, "wifi_connect", 4096, NULL, 1, &s_connect_task, 1);
    if (result != pdPASS) {
        s_connect_task = nullptr;
        s_status = STREAM_STATUS_FAILED;
        Serial.println("[streamer] failed to create WiFi connection task");
        notifyStreamStatus();
    }
}

void streamer_stop()
{
    s_running = false;
    s_streaming = false;
    if (s_stream_task) {
        vTaskDelay(pdMS_TO_TICKS(100));
        s_stream_task = nullptr;
    }
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    s_status = STREAM_STATUS_IDLE;
    s_ip = "";
    Serial.println("[streamer] stopped");
    notifyStreamStatus();
}

bool streamer_is_running()
{
    return s_running;
}

String streamer_get_ip()
{
    return s_ip;
}

int streamer_get_status()
{
    return s_status;
}

void streamer_set_config(int framesize, int quality)
{
    s_framesize = (framesize_t) framesize;
    s_quality = quality;
    if (s_running && s_streaming) {
        set_camera_for_streaming();
    }
    Serial.printf("[streamer] config updated: framesize=%d quality=%d\n", framesize, quality);
}

int streamer_get_framesize()
{
    return s_framesize;
}

int streamer_get_quality()
{
    return s_quality;
}
