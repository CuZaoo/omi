#ifndef STREAMER_H
#define STREAMER_H

#include <Arduino.h>

void streamer_start(const char *ssid, const char *password);
void streamer_stop();
bool streamer_is_running();
String streamer_get_ip();
int streamer_get_status();

#endif