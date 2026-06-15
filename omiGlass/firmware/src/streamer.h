#ifndef STREAMER_H
#define STREAMER_H

#include <Arduino.h>

void streamer_start(const char *ssid, const char *password);
void streamer_stop();
bool streamer_is_running();
String streamer_get_ip();
int streamer_get_status();
void streamer_set_config(int framesize, int quality);
int streamer_get_framesize();
int streamer_get_quality();

#endif