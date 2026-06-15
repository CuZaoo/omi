#include "streamer.h"

#include <WebServer.h>
#include <WiFi.h>

#include "config.h"
#include "esp_camera.h"

static bool s_running = false;
static bool s_streaming = false;
static String s_ip = "";
static int s_status = 0; // 0=idle, 1=connecting, 2=connected, 3=failed
static WebServer *s_server = nullptr;
static TaskHandle_t s_stream_task = nullptr;

static void set_camera_for_streaming()
{
    sensor_t *s = esp_camera_sensor_get();
    if (!s)
        return;
    framesize_t old_fs = s->status.framesize;
    if (old_fs != STREAM_FRAMESIZE) {
        s->set_framesize(s, STREAM_FRAMESIZE);
    }
    int old_q = s->status.quality;
    if (old_q != STREAM_JPEG_QUALITY) {
        s->set_quality(s, STREAM_JPEG_QUALITY);
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

void streamer_start(const char *ssid, const char *password)
{
    if (s_running) {
        streamer_stop();
        delay(500);
    }

    s_status = 1; // connecting
    s_ip = "";

    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
            s_status = 3; // failed
            Serial.println("[streamer] WiFi connect timeout");
            return;
        }
        delay(200);
        Serial.print(".");
    }
    Serial.println();

    s_ip = WiFi.localIP().toString();
    s_status = 2; // connected
    s_running = true;
    Serial.printf("[streamer] WiFi connected, IP: %s\n", s_ip.c_str());

    xTaskCreatePinnedToCore(stream_task, "stream_task", 8192, NULL, 1, &s_stream_task, 1);
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
    s_status = 0; // idle
    s_ip = "";
    Serial.println("[streamer] stopped");
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