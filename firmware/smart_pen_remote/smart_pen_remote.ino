/*
 * AirCAD "Smart Pen" remote - ESP32 BLE keyboard, four buttons.
 *
 * This sketch is deliberately a dumb transport.  It reports nothing but button
 * press/release; every mode, threshold, chord and CAD action lives in AirCAD
 * (web/src/input/remote.ts).  That split means the on-screen HUD can show the
 * current mode, the timings can be tuned without reflashing, and the same
 * remote works on macOS and Windows with no per-OS build.
 *
 * Button layout: 1 and 2 are on the right, 3 and 4 on the left.
 *
 *   button 1 -> F13   hold: draw / orbit / pan by mode, or the drag grab
 *                     tap: select, tap twice: undo
 *   button 2 -> F14   tap: cycle mode 1 -> 2 -> 3 -> 1
 *   button 3 -> F15   tap: Tab (work plane, or the active face while pulling)
 *                     hold: voice, release finalises
 *   button 4 -> F16   tap: Q to open a push/pull, tap again to apply
 *                     hold: move, release applies
 *   2 + 4             fit the view
 *   2 + 3             release everything
 *
 * F13-F16 are used rather than digits because AirCAD already binds 1/2/3 to
 * view presets, and because those keys are not printable: a button press can
 * never type into the measure dialog or the inspector.  Neither macOS nor
 * Windows claims F13-F16 by default.
 *
 * Library: T-vK/ESP32-BLE-Keyboard (defines KEY_F13..KEY_F24).
 * Verify pairing in AirCAD with `window.aircad.remote().lastCode`, which shows
 * the code the browser actually received.
 */
#include <Arduino.h>
#include <BleKeyboard.h>

BleKeyboard bleKeyboard("Smart Pen", "Maker", 100);

const int buttonPins[] = {0, 1, 3, 4};
const int numButtons = sizeof(buttonPins) / sizeof(buttonPins[0]);
// uint8_t, not char: KEY_F13..KEY_F16 are HID constants, not printable characters.
const uint8_t buttonKeys[] = {KEY_F13, KEY_F14, KEY_F15, KEY_F16};

int lastButtonStates[numButtons];
bool wasConnected = false;

void setup() {
  bleKeyboard.begin();
  for (int i = 0; i < numButtons; i++) {
    pinMode(buttonPins[i], INPUT_PULLUP);
    lastButtonStates[i] = HIGH;
  }
}

void loop() {
  if (!bleKeyboard.isConnected()) {
    // A button held across a dropped link never delivers its key-up, so forget
    // the held state; reconnecting with it still down sends a fresh press.
    if (wasConnected) {
      for (int i = 0; i < numButtons; i++) lastButtonStates[i] = HIGH;
      wasConnected = false;
    }
    return;
  }
  wasConnected = true;

  for (int i = 0; i < numButtons; i++) {
    int pin = buttonPins[i];
    int currentState = digitalRead(pin);
    if (currentState != lastButtonStates[i]) {
      if (currentState == LOW) {
        bleKeyboard.press(buttonKeys[i]);
      } else {
        bleKeyboard.release(buttonKeys[i]);
      }
      lastButtonStates[i] = currentState;
      delay(20); // Debounce
    }
  }
}
